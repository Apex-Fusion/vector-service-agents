import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { QUOTE_SCHEMA } from '../../../packages/usecase-kit/src/bids/index.ts';
import { PROPOSAL_SCHEMA, RESULT_SCHEMA } from '../../../packages/usecase-kit/src/protocol/index.ts';
import { BID_REPORT_SCHEMAS, bidEvaluation } from '../lib/evidence/bid-evaluation.ts';
import type { Obj } from '../lib/evidence/types.ts';
import data from '../usecases/bid-evaluation.ts';
import { bidRun } from './support/evidence-bid-world.ts';
import { parseEvidence } from '../tasks/results.ts';

// Only the manifest reader needs host resolution. The fixture supplies the HTTP response.
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '140.82.114.4', family: 4 }] }));

interface Step { id: string; status: 'shown' | 'not_run'; refs: Array<{ kind: string; value: string }>; note: string }
const ids = (kind: 'clean' | 'failure') => data.evidenceSteps.filter(({ run }) => run === kind).map(({ id }) => id);
const steps = (doc: Obj | null): Step[] => (doc?.steps ?? []) as Step[];

function checkGolden(kind: 'clean' | 'failure', actual: string): void {
  const path = new URL(`./golden/evidence-uc3-${kind}.json`, import.meta.url);
  if (process.env.WRITE_GOLDEN === '1') writeFileSync(path, actual);
  expect(actual).toBe(readFileSync(path, 'utf8'));
}

describe('bid evidence module', () => {
  it('covers all three run kinds and uses the role and schema contracts from the data and kit', () => {
    expect(bidEvaluation.runKinds).toEqual(['clean', 'failure', 'lifecycle']);
    const lifecycle = data.evidenceSteps.filter(({ run }) => run === 'lifecycle').map(({ id }) => id);
    expect(lifecycle).toHaveLength(7);
    expect(Object.keys(bidEvaluation.rules)).toEqual([...ids('clean'), ...ids('failure'), ...lifecycle]);
    const sourcing = data.agents.filter(({ kind }) => kind === 'sourcing-agent').map(({ id }) => id);
    expect(bidEvaluation.agentOf('propose')).toEqual(sourcing);
    expect(bidEvaluation.agentOf('execute')).toEqual(sourcing);
    expect(bidEvaluation.agentOf('quote')).toEqual(data.agents.filter(({ kind }) => kind === 'bid-desk').map(({ id }) => id));
    expect(bidEvaluation.agentOf('not-a-role')).toEqual([]);
    expect(bidEvaluation.reportOptional).toEqual([]);
    expect(BID_REPORT_SCHEMAS).toEqual({ propose: PROPOSAL_SCHEMA, execute: RESULT_SCHEMA, quote: QUOTE_SCHEMA });
    expect(bidEvaluation.hosted).toEqual(['vector_resolve_did']);
  });

  it.each(['clean', 'failure'] as const)('writes the complete %s run from checked reports and independent reads', async (kind) => {
    const got = await bidRun(kind);
    expect(got.exit, got.error).toBe(0);
    expect(steps(got.doc).map(({ id, status }) => [id, status]), JSON.stringify(steps(got.doc))).toEqual(ids(kind).map((id) => [id, 'shown']));
    const consumed = parseEvidence(got.doc, kind === 'clean' ? 'r1' : 'r2', data);
    expect([...consumed.steps.keys()]).toEqual(ids(kind));
    expect([...consumed.steps.values()].every((step) => step.status === 'shown' && step.refs.length > 0)).toBe(true);
    expect(got.doc).toMatchObject({ kind, run: `use-case-3-${kind}`, result_projection: { exit_state: kind === 'clean' ? 'Completed' : 'Rejected' } });
    expect(got.doc).not.toHaveProperty('result');
    expect(got.doc).not.toHaveProperty('receipt_signature');
    expect(got.doc?.model_hires).toHaveLength(kind === 'clean' ? 11 : 37);
    expect(got.doc?.quotes).toHaveLength(kind === 'clean' ? 3 : 10);
    for (const model of got.doc?.model_hires as Obj[]) expect(model).toEqual({
      step: expect.any(String), name: expect.any(String), escrow_ref: expect.stringMatching(/^[0-9a-f]{64}#0$/),
      advert_ref: expect.stringMatching(/^[0-9a-f]{64}#0$/), accept_tx: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const mock = got.doc?.mock as { log: Obj[] };
    expect(mock.log.every((row) => ['act', 'sub', 'proposal_digest', 'path'].every((key) => !Object.hasOwn(row, key)))).toBe(true);
    const text = got.text!;
    for (const phrase of ['Private quote notes.', 'Private quote choice.', 'Private model reasoning.', 'do not publish caller paths', 'watcher']) expect(text).not.toContain(phrase);
    if (kind === 'failure') {
      expect(got.doc).toMatchObject({ case: { verdict: 'AuditorWins', hold: { reason: 64 } }, approvals: [], compliance: { reason: 9 }, revocation: { reason: 9 } });
      expect(got.doc).toMatchObject({ hires: expect.arrayContaining([expect.objectContaining({
        step: 'quote-a3',
        verdict: 'VERIFIED',
        receipt_attribution: { record_ref: expect.any(String), submitted_ref: expect.any(String), submitted_at_ms: expect.any(Number), revocation: {
          record_ref: expect.any(String), invalid_from_ms: expect.any(Number), invalidates_submission: true,
        } },
      })]) });
      expect(steps(got.doc).find(({ id }) => id === 'r2-a-release')?.refs.map(({ kind: refKind }) => refKind)).toEqual(['escrow', 'transaction']);
      expect(got.doc).toMatchObject({ release: { action: 'Release', escrow_ref: expect.any(String), tx: expect.any(String), spent_output: expect.any(String), at: expect.any(Number) },
        route_evidence: [{ step: 'r2-d', route: 'POST /sourcing/rankings', credential: 'token', decision: 'refused', act_links: 1, count: 1 }] });
    } else {
      expect(got.doc).toMatchObject({ rfq_ids: ['RFQ-1'], mock: { state: { rankings: 1 } }, approvals: [{ hire: 'execute' }] });
      expect(got.doc).toMatchObject({ route_evidence: [
        { step: 'r1-05', route: 'GET /vendors', credential: 'token', decision: 'allowed', act_links: 2, count: 3 },
        { step: 'r1-07', route: 'POST /sourcing/rankings', credential: 'token', decision: 'allowed', act_links: 1, count: 1 },
      ] });
    }
    checkGolden(kind, text);
  });

  it.each([
    [{ wrongAuthority: true }, 'steps.r1-01'],
    [{ wrongProposal: true }, 'steps.r1-02'],
    [{ missingCatalog: true }, 'steps.r1-03'],
    [{ vault: 'other' }, 'steps.r1-04'],
    [{ vault: 'wallet' }, 'steps.r1-04'],
    [{ vault: 'close-replacement' }, 'vaults[0].close_tx'],
    [{ wrongDesk: true }, 'steps.r1-04'],
    [{ relationship: 'extra-rank' }, 'steps.r1-04'],
    [{ relationship: 'wrong-subjob' }, 'steps.r1-04'],
    [{ model: 'missing-output' }, 'steps.r1-03'],
    [{ model: 'wrong-output' }, 'steps.r1-03'],
    [{ model: 'wrong-model' }, 'steps.r1-03'],
    [{ model: 'wrong-buyer' }, 'steps.r1-03'],
    [{ model: 'no-accept' }, 'steps.r1-03'],
    [{ model: 'wrong-spend' }, 'steps.r1-03'],
    [{ model: 'bad-signature' }, 'steps.r1-03'],
    [{ model: 'reused' }, 'steps.r1-03'],
    [{ scorer: 'wrong-actor' }, 'steps.r1-05'],
    [{ scorer: 'wrong-parent' }, 'steps.r1-05'],
    [{ scorer: 'wrong-parent-record' }, 'steps.r1-05'],
    [{ scorer: 'wrong-delegate-key' }, 'steps.r1-05'],
    [{ scorer: 'same-delegate-key' }, 'steps.r1-05'],
    [{ scorer: 'same-did' }, 'steps.r1-05'],
    [{ model: 'late-confirmed' }, 'steps.r1-05'],
    [{ wrongApproval: true }, 'approvals[0]'],
    [{ wrongRanking: true }, 'steps.r1-07'],
    [{ correlation: 'wrong-digest' }, 'steps.r1-07'],
    [{ correlation: 'missing-digest' }, 'steps.r1-07'],
    [{ correlation: 'after-submit' }, 'steps.r1-07'],
    [{ correlation: 'before-post' }, 'steps.r1-07'],
    [{ correlation: 'unauthorized' }, 'steps.r1-07'],
    [{ correlation: 'dropped' }, 'steps.r1-07'],
    [{ correlation: 'duplicate' }, 'steps.r1-07'],
    [{ noClose: true }, 'steps.r1-08'],
  ] as const)('stops a clean file without its exact proof: %j', async (options, member) => {
    const got = await bidRun('clean', options);
    expect(got.exit, got.error).toBe(2);
    expect(got.error).toContain(member);
    expect(got.text).toBeNull();
  });

  it.each([
    [{ release: 'absent' }, 'r2-a-release'],
    [{ wrongEvidenceQuote: true }, 'r2-a'],
    [{ release: 'early' }, 'r2-a-release'],
    [{ release: 'not-release' }, 'r2-a-release'],
    [{ compliance: 'wrong-hash' }, 'r2-b'],
    [{ compliance: 'after-hold' }, 'r2-b'],
    [{ compliance: 'wrong-contest' }, 'r2-b'],
    [{ compliance: 'wrong-issuer' }, 'r2-b'],
    [{ holdProposal: 'with-target' }, 'r2-c'],
    [{ holdProposal: 'outside-hold' }, 'r2-c'],
    [{ holdProposal: 'before-apply' }, 'r2-c'],
    [{ absentExecute: true }, 'r2-d'],
    [{ wrongRequestDigest: true }, 'r2-d'],
    [{ wrongApproval: true }, 'r2-d'],
    [{ failureWrite: true }, 'r2-d'],
    [{ relationship: 'extra-rank' }, 'r2-d'],
    [{ relationship: 'wrong-subjob' }, 'r2-d'],
    [{ correlation: 'wrong-digest' }, 'r2-d'],
    [{ correlation: 'missing-digest' }, 'r2-d'],
    [{ correlation: 'after-submit' }, 'r2-d'],
    [{ reverse: 'wrong-score' }, 'r2-d'],
    [{ reverse: 'wrong-price' }, 'r2-d'],
    [{ reverse: 'wrong-lead-time' }, 'r2-d'],
    [{ reverse: 'wrong-reliability' }, 'r2-d'],
    [{ reverse: 'wrong-compliance' }, 'r2-d'],
    [{ revocation: 'wrong-author' }, 'r2-e'],
    [{ revocation: 'wrong-configured-key' }, 'r2-e'],
    [{ revocation: 'late-invalid-from' }, 'r2-e'],
    [{ revocation: 'resolver-active' }, 'r2-e'],
    [{ revocation: 'resolver-other' }, 'r2-e'],
    [{ revocation: 'resolver-unbound' }, 'r2-e'],
    [{ revocation: 'resolver-error' }, 'r2-e'],
    [{ revocation: 'no-tombstone' }, 'r2-e'],
  ] as const)('leaves the unproved failure step out: %j', async (options, id) => {
    const got = await bidRun('failure', options);
    expect(got.exit, got.error).toBe(0);
    expect(steps(got.doc).find((s) => s.id === id)).toMatchObject({ status: 'not_run', refs: [], note: expect.any(String) });
    expect(steps(got.doc).find((s) => s.id === id)?.note).not.toBe('');
  });

  it.each([
    [{ holdSpend: 'after-submit' }, 'shown'],
    [{ holdSpend: 'before-post' }, 'not_run'],
    [{ holdSpend: 'during-proposal' }, 'not_run'],
    [{ holdSpend: 'at-submit' }, 'not_run'],
    [{ holdProposal: 'at-apply' }, 'not_run'],
  ] as const)('checks the actual hold interval: %j', async (options, status) => {
    const got = await bidRun('failure', options);
    expect(got.exit, got.error).toBe(0);
    const byId = new Map(steps(got.doc).map((step) => [step.id, step]));
    expect(byId.get('r2-a-hold')?.status).toBe('shown');
    expect(byId.get('r2-e')?.status).toBe('shown');
    expect(byId.get('r2-c')?.status).toBe(status);
    if (status === 'not_run') expect(byId.get('r2-c')).toMatchObject({ refs: [], note: expect.stringContaining('Post and Submit') });
  });

  it.each(['pending', 'identity'] as const)('proves the settled model hires for %s from the exact chain', async (model) => {
    const got = await bidRun('clean', { model });
    expect(got.exit, got.error).toBe(0);
    expect(got.doc?.model_hires).toHaveLength(11);
    expect(steps(got.doc).every(({ status }) => status === 'shown')).toBe(true);
  });

  it('does not publish a resolver result for another DID or a synthetic result for an unproved model job', async () => {
    const wrongDid = await bidRun('failure', { revocation: 'resolver-other' });
    expect(wrongDid.doc?.resolutions).toEqual([]);
    const missingModel = await bidRun('failure', { model: 'missing-output' });
    expect(missingModel.exit, missingModel.error).toBe(0);
    expect(missingModel.doc?.model_hires).toHaveLength(36);
    expect(steps(missingModel.doc).find(({ id }) => id === 'r2-a')?.status).toBe('not_run');
  });

  it('waits for the case and does not treat a verdict for the claimer as a hold', async () => {
    const waiting = await bidRun('failure', { case: 'waiting' });
    expect(waiting.exit, waiting.error).toBe(4);
    expect(waiting.text).toBeNull();
    const lost = await bidRun('failure', { case: 'claimed' });
    expect(lost.exit, lost.error).toBe(0);
    expect(steps(lost.doc).find(({ id }) => id === 'r2-a-hold')).toMatchObject({ status: 'not_run', refs: [], note: expect.stringContaining('did not decide AuditorWins') });
  });

  it.each([
    [{ case: 'wrong-resolution' }, 'committed resolution document'],
    [{ reorderedIds: true }, 'rfq_ids'],
    [{ fault: 'off' }, 'no passing invert_scores'],
    [{ fault: 'different' }, 'no passing invert_scores'],
  ] as const)('refuses inconsistent run or case evidence: %j', async (options, member) => {
    const got = await bidRun('failure', options);
    expect(got.exit, got.error).toBe(2);
    expect(got.error).toContain(member);
    expect(got.text).toBeNull();
  });
});
