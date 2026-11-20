// packages/usecase-kit/test/buyer/results.test.ts: the results of a buyer-side agent, made from their pieces. Each helper writes every member of the result of its outcome. The exit state comes from
// `exitStateOf` and is never written by the caller. A piece of the wrong shape is a fault of the caller: the helper throws and makes no result. The typecheck is part of the test: a line that must not
// compile carries a `@ts-expect-error`.
import { describe, expect, it } from 'vitest';
import type { HireTerms } from '@vsa/hire-kit';
import { EXECUTE_OUTCOMES, NO_OPEN_CLAIM, PROPOSAL_SCHEMA, RESULT_SCHEMA, SYSTEM_REFUSALS, USE_CASES, exitStateOf, makeProposal, proposalDigest } from '@vsa/usecase-kit/protocol';
import type { ExecuteOutcome, ReceiptVerification } from '@vsa/usecase-kit/protocol';
import {
  BAD_DOCUMENT, INTERRUPTION_REASONS, PAY_UNCONFIRMED, completedResult, disputedResult, failedProposalResult, failedResult, proposedResult, refusedResult, settledResult, vaultRefusedResult,
} from '@vsa/usecase-kit/buyer';
import type { InterruptedStep, PayUnconfirmedStep, ProposalPieces, RefusedByCounterpartyStep, VaultRefusedStep } from '@vsa/usecase-kit/buyer';
import { COUNTERPARTY_DID, SALT, pieces, purchaseOrder } from './support.ts';

const ESCROW = `${'44'.repeat(32)}#0`;
const ADVERT = `${'55'.repeat(32)}#0`;
const TERMS: HireTerms = {
  price_lovelace: '200000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000', locked_lovelace: '2261030', paid_to_supplier_at_accept_lovelace: '1200000',
};
const handoff = {
  counterparty_did: COUNTERPARTY_DID, advert_ref: ADVERT, escrow_ref: ESCROW, paid_from_vault: true, receipt: null, receipt_signature: null, verification: null, result: null, accepted: null,
} as const;
const ALL_TRUE: ReceiptVerification = {
  escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true, prompt_hash_matches: true, model_matches: true, fields_match: true,
};
/** The record of a hire that was verified and accepted. */
const accepted = { ...handoff, receipt: { escrow_ref: ESCROW }, receipt_signature: 'cd'.repeat(64), verification: ALL_TRUE, result: { status: 'confirmed' }, accepted: 'confirmed' } as const;
const challenge = { claim: `${'66'.repeat(32)}#0`, evidence: '77'.repeat(32), challenge: `${'88'.repeat(32)}#0` };
const RESULT_KEYS = ['challenge', 'decisions', 'exit_state', 'fault_mode', 'handoff', 'outcome', 'proposal_digest', 'reason', 'schema', 'use_case', 'writes'];

describe('the results of execute', () => {
  it('makes a completed result with every member, and the state Completed', () => {
    const result = completedResult(pieces({ handoff: accepted }));
    expect(Object.keys(result).sort()).toStrictEqual(RESULT_KEYS);
    expect(result).toStrictEqual({
      schema: RESULT_SCHEMA, use_case: 'inventory-reorder', proposal_digest: '88'.repeat(32), handoff: accepted, writes: [], decisions: [], fault_mode: '', outcome: 'completed', reason: null, challenge: null,
      exit_state: 'Completed',
    });
  });

  it('makes a refusal by the counterparty and a refusal by a mock system, and the exit state follows the reason', () => {
    for (const [by, outcome] of [['counterparty', 'refused_by_counterparty'], ['system', 'refused_by_system']] as const) {
      expect(refusedResult(by, pieces(), 'approval_digest_mismatch')).toMatchObject({ outcome, reason: 'approval_digest_mismatch', challenge: null, exit_state: 'Rejected' });
      expect(refusedResult(by, pieces(), 'approval_expired')).toMatchObject({ outcome, reason: 'approval_expired', exit_state: 'Expired' });
      expect(refusedResult(by, pieces(), 'delegation_ended')).toMatchObject({ outcome, reason: 'delegation_ended', exit_state: 'Cancelled' });
      expect(Object.keys(refusedResult(by, pieces(), 'x')).sort()).toStrictEqual(RESULT_KEYS);
    }
    for (const code of SYSTEM_REFUSALS) expect(refusedResult('system', pieces(), code).exit_state).toBe(exitStateOf({ outcome: 'refused_by_system', reason: code, challenge_filed: false, delegation_ended: false }));
  });

  it('makes a refusal of the vault, Cancelled when the delegation ended and Failed in every other case', () => {
    expect(vaultRefusedResult(pieces(), '3010 Some scripts of the transactions terminated with error(s).', false)).toMatchObject({ outcome: 'vault_refused', exit_state: 'Failed', challenge: null });
    expect(vaultRefusedResult(pieces(), 'no_delegation', true)).toMatchObject({ outcome: 'vault_refused', reason: 'no_delegation', exit_state: 'Cancelled' });
    expect(Object.keys(vaultRefusedResult(pieces(), 'x', true)).sort()).toStrictEqual(RESULT_KEYS);
  });

  it('refuses a flag that is not a boolean: a text such as "false" is not read as false, and no result is made', () => {
    for (const flag of ['false', 'true', 0, 1, null, undefined]) expect(() => vaultRefusedResult(pieces(), 'x', flag as never), String(flag)).toThrow(TypeError);
  });

  it('makes a failed result, and the state Failed', () => {
    expect(failedResult(pieces({ handoff }), 'send_lost')).toMatchObject({ outcome: 'failed', reason: 'send_lost', challenge: null, exit_state: 'Failed', handoff });
    expect(Object.keys(failedResult(pieces(), 'x')).sort()).toStrictEqual(RESULT_KEYS);
  });

  it('makes a dispute: Escalated with the challenge that was filed, and Failed with no challenge and a reason', () => {
    const escalated = disputedResult(pieces({ handoff }), { challenge });
    expect(escalated).toMatchObject({ outcome: 'disputed', reason: null, challenge, exit_state: 'Escalated' });
    expect(Object.keys(escalated).sort()).toStrictEqual(RESULT_KEYS);
    expect(disputedResult(pieces({ handoff }), { reason: NO_OPEN_CLAIM })).toMatchObject({ outcome: 'disputed', reason: NO_OPEN_CLAIM, challenge: null, exit_state: 'Failed' });
    expect(disputedResult(pieces({ handoff }), { reason: 'challenge_failed' })).toMatchObject({ reason: 'challenge_failed', challenge: null, exit_state: 'Failed' });
  });

  it('gives the state that exitStateOf gives for every outcome and every flag: the helpers hold no state of their own', () => {
    const made: Array<[ExecuteOutcome, string | null, boolean, boolean, string]> = [
      ['completed', null, false, false, completedResult(pieces({ handoff: accepted })).exit_state],
      ['refused_by_counterparty', 'approval_expired', false, false, refusedResult('counterparty', pieces(), 'approval_expired').exit_state],
      ['refused_by_system', 'delegation_ended', false, false, refusedResult('system', pieces(), 'delegation_ended').exit_state],
      ['vault_refused', 'r', false, true, vaultRefusedResult(pieces(), 'r', true).exit_state],
      ['vault_refused', 'r', false, false, vaultRefusedResult(pieces(), 'r', false).exit_state],
      ['disputed', null, true, false, disputedResult(pieces(), { challenge }).exit_state],
      ['disputed', 'r', false, false, disputedResult(pieces(), { reason: 'r' }).exit_state],
      ['failed', 'r', false, false, failedResult(pieces(), 'r').exit_state],
    ];
    for (const [outcome, reason, filed, ended, state] of made) expect(state, `${outcome} ${reason}`).toBe(exitStateOf({ outcome, reason, challenge_filed: filed, delegation_ended: ended }));
    expect(EXECUTE_OUTCOMES.every((outcome) => made.some(([name]) => name === outcome))).toBe(true);
  });

  it('refuses a reason that is not a code: an empty text, a number, nothing', () => {
    for (const reason of ['', 7, null, undefined]) {
      expect(() => refusedResult('counterparty', pieces(), reason as never)).toThrow(TypeError);
      expect(() => vaultRefusedResult(pieces(), reason as never, false)).toThrow(TypeError);
      expect(() => failedResult(pieces(), reason as never)).toThrow(TypeError);
      expect(() => disputedResult(pieces(), { reason } as never)).toThrow(TypeError);
    }
    expect(() => refusedResult('hirer' as never, pieces(), 'x')).toThrow(TypeError);
  });

  it('refuses a completed result when the record is not the record of a hire that was verified and accepted: a refused or failed hire is never reported as completed', () => {
    const records: Array<[string, unknown]> = [
      ['no record', null], ['a hire that no delivery came for', handoff], ['a delivery that the decision did not accept', { ...accepted, accepted: 'no' }],
      ['an Accept that is not known', { ...accepted, accepted: null }], ['a check that is false', { ...accepted, verification: { ...ALL_TRUE, model_matches: false } }],
      ['a record with no checks', { ...accepted, verification: null }], ['a record with no receipt', { ...accepted, receipt: null }], ['a record with no signature', { ...accepted, receipt_signature: null }],
    ];
    for (const useCase of ['inventory-reorder', 'prior-authorization'] as const) {
      for (const [name, record] of records) expect(() => completedResult(pieces({ use_case: useCase, handoff: record as never })), `${useCase}: ${name}`).toThrow(TypeError);
    }
    // The twins: an Accept that is pending is an accepted hire, and use case 3 (supplier bid evaluation) hires no counterparty to execute.
    expect(completedResult(pieces({ handoff: { ...accepted, accepted: 'pending' } })).outcome).toBe('completed');
    expect(completedResult(pieces({ use_case: 'bid-evaluation', handoff: null })).exit_state).toBe('Completed');
  });

  it('refuses pieces of the wrong shape, and makes no result', () => {
    const wrong: Array<[string, Record<string, unknown>]> = [
      ['a use case that the protocol does not have', { use_case: 'payroll' }], ['a digest that is no digest', { proposal_digest: 'abc' }], ['a handoff that is a list', { handoff: [] }],
      ['a handoff that is a text', { handoff: 'done' }], ['writes that are no list', { writes: 'none' }], ['decisions that are no list', { decisions: undefined }], ['a fault setting that is no text', { fault_mode: null }],
    ];
    for (const [name, over] of wrong) expect(() => completedResult({ ...pieces({ handoff: accepted }), ...over } as never), name).toThrow(TypeError);
    for (const useCase of USE_CASES) expect(completedResult(pieces({ use_case: useCase, handoff: accepted })).use_case).toBe(useCase);
  });

  it('keeps no list of the caller: a write that the caller adds later is not in the result', () => {
    const writes = [{ system: 'po-store', route: 'POST /po', status: 201, ref: 'po-1' }];
    const decisions: never[] = [];
    const result = completedResult(pieces({ handoff: accepted, writes, decisions }));
    writes.push({ system: 'po-store', route: 'POST /po', status: 201, ref: 'po-2' });
    expect(result.writes).toHaveLength(1);
    expect(result.writes).not.toBe(writes);
    expect(result.decisions).not.toBe(decisions);
  });

  it('does not compile a result with a member left out, or with a state of the caller', () => {
    // The lines below are never run: the typecheck is the test, and each line must not compile.
    const compileOnly = (): void => {
      // @ts-expect-error The pieces need the writes.
      const noWrites: Parameters<typeof completedResult>[0] = { use_case: 'inventory-reorder', proposal_digest: '88'.repeat(32), handoff: null, decisions: [], fault_mode: '' };
      void noWrites;
      // @ts-expect-error A refusal is by the counterparty or by a mock system, and it takes no state.
      refusedResult('hirer', pieces(), 'x', 'Rejected');
      // @ts-expect-error A dispute holds a challenge or a reason.
      disputedResult(pieces(), {});
    };
    expect(compileOnly).toBeTypeOf('function');
  });
});

describe('settledResult', () => {
  const settled = pieces({ handoff: null });
  const { handoff: _handoff, ...base } = settled;
  const refused: RefusedByCounterpartyStep = { kind: 'refused_by_counterparty', reason: 'approval_expired', source: 'before_claim', runtime_status: 403, handoff, vault_ref: null, terms: TERMS };
  const vault: VaultRefusedStep = { kind: 'vault_refused', reason: 'no_delegation', refusal: 'impossible', delegation: 'ended', delegation_ended: true, evidence: { transaction_body: null }, handoff: null };
  const interrupted = (cause: InterruptedStep['cause_kind']): InterruptedStep => ({ kind: 'interrupted', cause_kind: cause, detail: 'x', vault_ref: ESCROW, escrow_ref: ESCROW, handoff, delivery: null, cause: new Error('x') });
  const unconfirmed: PayUnconfirmedStep = {
    kind: 'pay_unconfirmed', detail: 'x', escrow_ref: ESCROW, vault_ref_if_landed: ESCROW, tx_hash: '44'.repeat(32), may_land: true, valid_to: 1, handoff, cause: new Error('x'),
  };

  it('makes the result of each step that the use case does not have to finish, with the handoff of the step', () => {
    expect(settledResult(refused, base)).toMatchObject({ outcome: 'refused_by_counterparty', reason: 'approval_expired', exit_state: 'Expired', handoff });
    expect(settledResult(vault, base)).toMatchObject({ outcome: 'vault_refused', reason: 'no_delegation', exit_state: 'Cancelled', handoff: null });
    expect(settledResult({ kind: 'failed', reason: 'timeout', detail: 'x', handoff, vault_ref: null, terms: null }, base)).toMatchObject({ outcome: 'failed', reason: 'timeout', exit_state: 'Failed', handoff });
    expect(settledResult(unconfirmed, base)).toMatchObject({ outcome: 'failed', reason: PAY_UNCONFIRMED, exit_state: 'Failed', handoff });
    for (const cause of ['deadline', 'store_write', 'decision_error', 'other'] as const) {
      expect(settledResult(interrupted(cause), base)).toMatchObject({ outcome: 'failed', reason: INTERRUPTION_REASONS[cause], exit_state: 'Failed', handoff });
    }
  });

  it('names a reason of its own for each interruption, and none of them is the reason of a refusal', () => {
    expect(INTERRUPTION_REASONS).toStrictEqual({ deadline: 'deadline', store_write: 'store_write_failed', decision_error: 'decision_error', other: 'hire_interrupted' });
  });

  it('throws for a step that the use case must finish, and never makes `completed` of it', () => {
    for (const kind of ['completed', 'not_accepted', 'refused'] as const) expect(() => settledResult({ kind } as never, base), kind).toThrow(TypeError);
  });
});

describe('the result of propose', () => {
  const proposalPieces: ProposalPieces = { use_case: 'inventory-reorder', decisions: [], sub_jobs: [], fault_mode: '' };

  it('makes the proposal of the document: the salt that is given, the digest of the salt and the document, no exit state and no reason', () => {
    const made = makeProposal(purchaseOrder(), SALT);
    const digest = proposalDigest(SALT, purchaseOrder());
    if (!made.ok || !digest.ok) throw new Error('refused');
    expect(proposedResult(purchaseOrder(), proposalPieces, SALT)).toStrictEqual({
      schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', decisions: [], sub_jobs: [], fault_mode: '', document: purchaseOrder(), salt: SALT, proposal_digest: digest.value, outcome: 'proposed',
      exit_state: null, reason: null,
    });
    expect(made.value.proposal_digest).toBe(digest.value);
  });

  it('makes a new salt for each proposal when none is given, so that two proposals of one document have two digests', () => {
    const a = proposedResult(purchaseOrder(), proposalPieces);
    const b = proposedResult(purchaseOrder(), proposalPieces);
    if (a.outcome !== 'proposed' || b.outcome !== 'proposed') throw new Error('not proposed');
    expect(a.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(a.salt).not.toBe(b.salt);
    expect(a.proposal_digest).not.toBe(b.proposal_digest);
  });

  it('makes a failed proposal with no document when the document is refused, and when its schema is not the schema of the use case', () => {
    const bad: unknown[] = [{ schema: 'vector.usecase.po.v1', quantity: undefined }, { schema: 'vector.usecase.po.v1', quantity: () => 1 }, { schema: 'vector.usecase.po.v1', n: 10n }, 'a text', null, [], { schema: 'vector.usecase.ranking.v1' }, {}];
    for (const document of bad) {
      expect(proposedResult(document, proposalPieces), JSON.stringify(String(document))).toStrictEqual({
        schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', decisions: [], sub_jobs: [], fault_mode: '', document: null, salt: null, proposal_digest: null, outcome: 'failed', exit_state: 'Failed', reason: BAD_DOCUMENT,
      });
    }
    // The twin: the document of the right schema is proposed, and each use case has its own schema.
    expect(proposedResult(purchaseOrder(), proposalPieces).outcome).toBe('proposed');
    expect(proposedResult({ schema: 'vector.usecase.ranking.v1' }, { ...proposalPieces, use_case: 'bid-evaluation' }).outcome).toBe('proposed');
    expect(proposedResult({ schema: 'vector.usecase.priorauth-request.v1' }, { ...proposalPieces, use_case: 'prior-authorization' }).outcome).toBe('proposed');
  });

  it('refuses a salt that is not a salt: the proposal is failed with no document', () => {
    expect(proposedResult(purchaseOrder(), proposalPieces, 'abc')).toMatchObject({ outcome: 'failed', reason: BAD_DOCUMENT, document: null, salt: null, proposal_digest: null });
  });

  it('makes a failed proposal for a job that failed, with the proposal when it had one and nulls when it had none', () => {
    const made = makeProposal(purchaseOrder(), SALT);
    if (!made.ok) throw new Error('refused');
    expect(failedProposalResult(proposalPieces, 'llm_timeout')).toMatchObject({ outcome: 'failed', exit_state: 'Failed', reason: 'llm_timeout', document: null, salt: null, proposal_digest: null });
    expect(failedProposalResult(proposalPieces, 'llm_timeout', made.value)).toMatchObject({ document: purchaseOrder(), salt: SALT, proposal_digest: made.value.proposal_digest });
    expect(() => failedProposalResult(proposalPieces, '')).toThrow(TypeError);
  });

  it('refuses pieces of the wrong shape and keeps no list of the caller', () => {
    expect(() => proposedResult(purchaseOrder(), { ...proposalPieces, use_case: 'payroll' } as never)).toThrow(TypeError);
    expect(() => proposedResult(purchaseOrder(), { ...proposalPieces, decisions: 'none' } as never)).toThrow(TypeError);
    expect(() => proposedResult(purchaseOrder(), { ...proposalPieces, sub_jobs: undefined } as never)).toThrow(TypeError);
    expect(() => proposedResult(purchaseOrder(), { ...proposalPieces, fault_mode: null } as never)).toThrow(TypeError);
    const decisions: never[] = [];
    const result = proposedResult(purchaseOrder(), { ...proposalPieces, decisions });
    expect(result.decisions).not.toBe(decisions);
  });
});
