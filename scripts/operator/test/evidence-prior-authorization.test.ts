import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INTAKE_RECORD_SCHEMA } from '../../../packages/usecase-kit/src/priorauth/index.ts';
import { PROPOSAL_SCHEMA, RESULT_SCHEMA } from '../../../packages/usecase-kit/src/protocol/index.ts';
import { priorAuthorization } from '../lib/evidence/prior-authorization.ts';
import type { Obj } from '../lib/evidence/types.ts';
import data from '../usecases/prior-authorization.ts';
import { h, rf, writePriorEvidence } from './support/prior-evidence-world.ts';
import type { PriorFixture, PriorOutcome } from './support/prior-evidence-world.ts';

interface EvidenceDoc extends Obj {
  readonly steps: readonly { id: string; status: string; note: string; refs: readonly { kind: string; value: string }[] }[];
}
const asDoc = (outcome: PriorOutcome): EvidenceDoc => {
  if (outcome.text === null) throw new Error(`No evidence file: ${outcome.errors}`);
  return JSON.parse(outcome.text);
};

it('uses the roles, schemas and fourteen evidence steps of the data', () => {
  const draft = data.agents.find((one) => one.kind === 'prior-authorization-agent')!.id;
  const intake = data.agents.find((one) => one.kind === 'insurer-intake-agent')!.id;
  expect(priorAuthorization.runKinds).toEqual(['clean', 'failure']);
  expect(priorAuthorization.hireRoles).toEqual(['propose', 'execute', 'intake']);
  expect(priorAuthorization.reportOptional).toEqual(['intake']);
  expect(priorAuthorization.agentOf('propose')).toEqual([draft]);
  expect(priorAuthorization.agentOf('execute')).toEqual([draft]);
  expect(priorAuthorization.agentOf('intake')).toEqual([intake]);
  expect(priorAuthorization.agentOf('another')).toEqual([]);
  expect(priorAuthorization.reportSchemas).toEqual({ propose: PROPOSAL_SCHEMA, execute: RESULT_SCHEMA, intake: INTAKE_RECORD_SCHEMA });
  expect(Object.keys(priorAuthorization.rules)).toEqual(data.evidenceSteps.map((one) => one.id));
  expect(Object.keys(priorAuthorization.rules)).toHaveLength(14);
});

for (const kind of ['clean', 'failure'] as const) {
  it(`writes a complete ${kind} evidence file, with every step and no private signed data`, async () => {
    const outcome = await writePriorEvidence({ kind });
    expect(outcome.errors).toBe('');
    expect(outcome.exit).toBe(0);
    const doc = asDoc(outcome);
    expect(doc.steps.map((one) => one.id)).toEqual(data.evidenceSteps.filter((one) => one.run === kind).map((one) => one.id));
    expect(doc.steps.filter((one) => one.status !== 'shown' || one.refs.length === 0 || one.note !== '').map(({ id, note }) => [id, note])).toEqual([]);
    expect(doc).toMatchObject({ result_projection: { operation: 'execute', outcome: kind === 'clean' ? 'completed' : 'refused_by_counterparty' },
      result_sha256: createHash('sha256').update(outcome.receiptText, 'utf8').digest('hex') });
    for (const field of ['receipt', 'receipt_signature', 'result']) expect(doc).not.toHaveProperty(field);
    for (const text of ['private fixture clinical justification', 'private clinical decision text', 'SYN-PT-0042', 'private gateway observation', '/fixture/private/patient', 'fixture refusal.', 'INT-fixture-0001']) {
      expect(outcome.text).not.toContain(text);
    }
    const executeStep = kind === 'clean' ? 'execute' : 'execute-d2';
    const intakeStep = kind === 'clean' ? 'intake' : 'intake-d2';
    expect(doc.handoff_evidence).toEqual({
      execute_step: executeStep, execute_escrow: rf(`post ${executeStep}`),
      execute_result_sha256: (doc.hires as Obj[]).find((hire) => hire.step === executeStep)?.result_sha256,
      intake_step: intakeStep, intake_escrow: rf(`post ${intakeStep}`), signed_acceptance: 'confirmed', confirmed_accept_tx: h(`accept ${intakeStep}`),
    });
    expect(doc.route_evidence).toEqual(kind === 'failure' ? [] : [
      { step: 'r1-02', route: 'GET /records/orders/{order_id}', credential: 'token', decision: 'allowed', act_links: 2, count: 1 },
      { step: 'r1-02', route: 'GET /guidelines/{code}', credential: 'token', decision: 'allowed', act_links: 2, count: 1 },
      { step: 'r1-05', route: 'POST /insurer/requests', credential: 'jwt-svid', decision: 'allowed', act_links: 0, count: 1 },
      { step: 'r1-06', route: 'POST /records/orders/{order_id}/submission', credential: 'token', decision: 'allowed', act_links: 1, count: 1 },
    ]);
    if (kind === 'failure') {
      expect(doc.approvals).toEqual([
        expect.objectContaining({ attestation: h('approval d1'), hire: 'execute-d1', state_at_hire: 'revoked', link: 'request' }),
        expect.objectContaining({ attestation: h('approval d2'), hire: 'execute-d2', state_at_hire: 'active', link: 'request', supersedes: h('approval d1') }),
        expect.objectContaining({ attestation: h('approval e'), hire: 'execute-e', state_at_hire: 'expired', link: 'request' }),
        expect.objectContaining({ attestation: h('approval a'), hire: 'execute-a', state_at_hire: 'active', link: 'request' }),
      ]);
      expect(doc.steps.find((one) => one.id === 'r2-e')?.refs).toEqual(expect.arrayContaining([
        { kind: 'vault', value: rf('reclaim intake-e') }, { kind: 'vault', value: rf('reclaim intake-e', 1) },
      ]));
      expect(doc.steps.find(({ id }) => id === 'r2-b-hold')?.refs).toEqual(expect.arrayContaining([
        { kind: 'verdict', value: rf('resolve challenge', 1) }, { kind: 'hold', value: rf('apply verdict', 2) },
      ]));
      expect(doc.steps.find(({ id }) => id === 'r2-c')?.refs).toContainEqual({ kind: 'hold', value: rf('epoch bump') });
      expect(doc.probe).toMatchObject({ control: { status: null, token_type: 'DPoP' }, refusal: { status: 400, code: 'invalid_request' } });
    }
    const golden = new URL(`./golden/evidence-uc2-${kind}.json`, import.meta.url);
    if (process.env.WRITE_GOLDEN === '1') writeFileSync(golden, outcome.text!);
    expect(outcome.text).toBe(readFileSync(golden, 'utf8'));
  });
}

it('keeps the exact signed result in a private evidence file', async () => {
  const outcome = await writePriorEvidence({ kind: 'clean' }, true);
  expect(outcome.errors).toBe('');
  expect(outcome.exit).toBe(0);
  expect(asDoc(outcome)).toMatchObject({ audience: 'private', result: outcome.receiptText });
});

describe('clean run proof', () => {
  const breaks: Array<[string, Partial<PriorFixture>, string]> = [
    ['r1-01', { binding: 'missing' }, 'principal binding'],
    ['r1-02', { delegation: 'wrong_child' }, 'two child delegations'],
    ['r1-02', { mock: 'no_read' }, 'both attributed reads'],
    ['r1-02', { draftDecision: 'missing' }, 'justification decision'],
    ['r1-02', { mock: 'read_after_end' }, 'both attributed reads'],
    ['r1-02', { mock: 'read_after_propose' }, 'both attributed reads'],
    ['r1-03', { rejectApproval: 'wrong_proposal' }, 'does not prove the approval of this proposal'],
    ['r1-04', { handoff: 'wrong_ref' }, 'signed handoff'],
    ['r1-04', { handoff: 'wrong_receipt' }, 'signed handoff'],
    ['r1-04', { vault: 'wallet' }, 'payment from the run vault'],
    ['r1-04', { vault: 'different_vault' }, 'payment from the run vault'],
    ['r1-05', { mock: 'x509' }, 'JWT-SVID'],
    ['r1-05', { mock: 'no_filing_log' }, 'JWT-SVID'],
    ['r1-05', { intakeChecks: 'missing' }, 'fifteen checks'],
    ['r1-06', { mock: 'wrong_submission' }, 'matching records submission'],
    ['r1-07', { delegation: 'not_closed' }, 'did not both end'],
  ];
  for (const [step, options, detail] of breaks) it(`refuses ${step} when ${Object.keys(options).join(' ')} is unproved`, async () => {
    const outcome = await writePriorEvidence({ kind: 'clean', ...options });
    expect(outcome.exit).toBe(2);
    expect(outcome.errors).toContain(`steps.${step}`);
    expect(outcome.errors).toContain(detail);
    expect(outcome.text).toBeNull();
  });
  for (const [options, detail] of [
    [{ binding: 'wrong_type' }, 'approvals[0].type'],
    [{ binding: 'wrong_issuer' }, 'approvals[0].issuer'],
    [{ rejectApproval: 'missing_preimage' }, 'the exact execute approval is unproven'],
  ] satisfies Array<[Partial<PriorFixture>, string]>) it(`refuses ${detail} without changing the signed bytes`, async () => {
    const outcome = await writePriorEvidence({ kind: 'clean', ...options });
    expect(outcome.exit).toBe(2);
    expect(outcome.errors).toContain(detail);
    expect(outcome.text).toBeNull();
  });
  it('keeps signed pending separate from confirmed ledger acceptance', async () => {
    const pending = await writePriorEvidence({ kind: 'clean', handoff: 'pending' });
    expect(pending.exit).toBe(0);
    expect(asDoc(pending).handoff_evidence).toMatchObject({ signed_acceptance: 'pending', confirmed_accept_tx: h('accept intake') });
    const unconfirmed = await writePriorEvidence({ kind: 'clean', handoff: 'pending_without_confirmation' });
    expect(unconfirmed.exit).toBe(2);
    expect(unconfirmed.errors).toContain('.accept_tx');
    expect(unconfirmed.text).toBeNull();
  });
});

describe('failure run proof', () => {
  const notShown: Array<[string, Partial<PriorFixture>]> = [
    ['r2-d', { handoff: 'wrong_receipt' }],
    ['r2-e', { rejectApproval: 'expired_exit' }],
    ['r2-a', { fault: 'missing' }],
    ['r2-a', { fault: 'late' }],
    ['r2-a', { mock: 'fault_filed' }],
    ['r2-b-hold', { case: 'ClaimerWins' }],
    ['r2-c', { case: 'expired_hold' }],
    ['r2-c', { end: 'wrong_redeemer' }],
    ['r2-c', { listing: 'listed' }],
    ['r2-c', { listing: 'no_refusal' }],
    ['r2-f', { end: 'wrong_redeemer' }],
    ['r2-f', { end: 'wrong_epoch' }],
    ['r2-f', { end: 'resolver_active' }],
    ['r2-f', { end: 'probe_before' }],
    ['r2-f', { end: 'wrong_probe_subject' }],
    ['r2-f', { end: 'wrong_resource' }],
    ['r2-f', { end: 'wrong_action' }],
    ['r2-f', { end: 'generic_grant' }],
    ['r2-f', { end: 'generic_refusal' }],
    ['r2-f', { end: 'noncanonical_time' }],
  ];
  for (const [id, options] of notShown) it(`does not show ${id} for ${JSON.stringify(options)}`, async () => {
    const outcome = await writePriorEvidence({ kind: 'failure', ...options });
    expect(outcome.errors).toBe('');
    expect(outcome.exit).toBe(0);
    expect(asDoc(outcome).steps.find((one) => one.id === id)).toMatchObject({ status: 'not_run', note: expect.any(String), refs: [] });
    if (id === 'r2-c' && options.case === 'expired_hold') {
      expect(asDoc(outcome).steps.find((one) => one.id === 'r2-b-hold')).toMatchObject({ status: 'shown' });
    }
  });
  const stops: Array<[Partial<PriorFixture>, string]> = [
    [{ rejectApproval: 'same_digest_wrong_id' }, 'the exact execute approval is unproven'],
    [{ rejectApproval: 'wrong_supersedes' }, 'approvals[1].supersedes'],
    [{ rejectApproval: 'not_revoked' }, 'the approval is active at its hire, not revoked'],
    [{ rejectApproval: 'same_block_revoke' }, 'the order of revocation and hire in the same block is unproven'],
    [{ case: 'wrong_auditor' }, 'ledger parties, transaction key or claim'],
    [{ case: 'wrong_key' }, 'ledger parties, transaction key or claim'],
    [{ case: 'controller_only' }, 'ledger parties, transaction key or claim'],
    [{ case: 'wrong_claimer' }, 'ledger parties, transaction key or claim'],
    [{ case: 'wrong_document' }, 'the evidence document does not bind the fault hire'],
    [{ case: 'wrong_approval' }, 'the evidence document does not bind the fault hire, exact approval, digests and both parties'],
    [{ case: 'wrong_digest' }, 'the evidence document does not bind the fault hire, exact approval, digests and both parties'],
    [{ case: 'wrong_kind' }, 'the evidence document does not bind the fault hire, exact approval, digests and both parties'],
    [{ case: 'wrong_wire' }, 'the evidence document does not bind the fault hire, exact approval, digests and both parties'],
    [{ case: 'early_hold' }, 'the application output does not show the Module-1 hold'],
    [{ case: 'missing_application' }, 'the current hold alone does not prove it'],
    [{ case: 'wrong_application' }, 'the application does not spend this verdict and create the subject record'],
    [{ case: 'wrong_resolution' }, 'the committed resolution document names a different jury, case or challenge'],
    [{ vault: 'wrong_refund_owner' }, 'the matching vault outputs do not show the full escrow value'],
  ];
  for (const [options, detail] of stops) it(`refuses ${JSON.stringify(options)} without publishing evidence`, async () => {
    const outcome = await writePriorEvidence({ kind: 'failure', ...options });
    expect(outcome.exit).toBe(2);
    expect(outcome.errors).toContain(detail);
    expect(outcome.text).toBeNull();
  });
  it.each(['pending', 'no_jury'] as const)('waits for the actual verdict for %s', async (item) => {
    const outcome = await writePriorEvidence({ kind: 'failure', case: item });
    expect(outcome.exit).toBe(4);
    expect(outcome.output).toContain('the case of the challenge has no verdict');
    expect(outcome.text).toBeNull();
  });
  it('waits when the case decided but no verdict was applied', async () => {
    const outcome = await writePriorEvidence({ kind: 'failure', case: 'unapplied' });
    expect(outcome.exit).toBe(4);
    expect(outcome.output).toContain('the hold is not yet on the record');
    expect(outcome.text).toBeNull();
  });
});
