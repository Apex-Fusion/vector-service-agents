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
  it('covers only the clean and failure steps and uses the role and schema contracts from the data and kit', () => {
    expect(bidEvaluation.runKinds).toEqual(['clean', 'failure']);
    expect(Object.keys(bidEvaluation.rules)).toEqual([...ids('clean'), ...ids('failure')]);
    const sourcing = data.agents.filter(({ kind }) => kind === 'sourcing-agent').map(({ id }) => id);
    expect(bidEvaluation.agentOf('propose')).toEqual(sourcing);
    expect(bidEvaluation.agentOf('execute')).toEqual(sourcing);
    expect(bidEvaluation.agentOf('quote')).toEqual(data.agents.filter(({ kind }) => kind === 'bid-desk').map(({ id }) => id));
    expect(bidEvaluation.agentOf('not-a-role')).toEqual([]);
    expect(bidEvaluation.reportOptional).toEqual([]);
    expect(BID_REPORT_SCHEMAS).toEqual({ propose: PROPOSAL_SCHEMA, execute: RESULT_SCHEMA, quote: QUOTE_SCHEMA });
    expect(bidEvaluation.hosted).toEqual(['vector_marketplace_list_suppliers', 'vector_resolve_did']);
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
    [{ wrongDesk: true }, 'steps.r1-04'],
    [{ scorer: 'wrong-actor' }, 'steps.r1-05'],
    [{ scorer: 'wrong-parent' }, 'steps.r1-05'],
    [{ wrongApproval: true }, 'approvals[0]'],
    [{ wrongRanking: true }, 'steps.r1-07'],
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
    [{ listing: 'with-target' }, 'r2-c'],
    [{ listing: 'outside-hold' }, 'r2-c'],
    [{ absentExecute: true }, 'r2-d'],
    [{ wrongRequestDigest: true }, 'r2-d'],
    [{ wrongApproval: true }, 'r2-d'],
    [{ failureWrite: true }, 'r2-d'],
    [{ revocation: 'wrong-author' }, 'r2-e'],
    [{ revocation: 'late-invalid-from' }, 'r2-e'],
    [{ revocation: 'resolver-active' }, 'r2-e'],
  ] as const)('leaves the unproved failure step out: %j', async (options, id) => {
    const got = await bidRun('failure', options);
    expect(got.exit, got.error).toBe(0);
    expect(steps(got.doc).find((s) => s.id === id)).toMatchObject({ status: 'not_run', refs: [], note: expect.any(String) });
    expect(steps(got.doc).find((s) => s.id === id)?.note).not.toBe('');
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
