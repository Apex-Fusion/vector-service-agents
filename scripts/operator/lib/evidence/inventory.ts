import { PreconditionError } from '../../../checks/lib/session.ts';
import { RUN_APPROVAL_VALIDITY_MS } from '../claim-constants.ts';
import { isObject, lastHire, ref } from './types.ts';
import type { Assembly, Challenge, EvidenceModule, HireView, Loaded, Obj, Ref, ReportedHire, Shown, VaultPayment } from './types.ts';

export const PROPOSAL_SCHEMA = 'vector.usecase.proposal.v1';
export const RESULT_SCHEMA = 'vector.usecase.result.v1';
export const CONFIRMATION_SCHEMA = 'vector.usecase.order-confirmation.v1';
const APPROVAL_CLOCK_SLACK_MS = 60_000;
const REORDER = 'reorder-agent';
const DESK = 'order-desk';
const HIRE_ROLES = ['propose', 'execute', DESK] as const;
const HASH = /^[0-9a-f]{64}$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,5})$/;

function challengeOf(a: Assembly): Challenge | null {
  const found = a.loaded.carried?.result.challenge;
  if (isObject(found) && typeof found.claim === 'string' && REF.test(found.claim)
      && typeof found.evidence === 'string' && HASH.test(found.evidence) && typeof found.challenge === 'string' && REF.test(found.challenge)) {
    return { agent: DESK, claim: found.claim, evidence: found.evidence, challenge: found.challenge };
  }
  if (a.loaded.record.kind === 'failure' || (found !== null && found !== undefined)) {
    throw new PreconditionError('case: no hire of execute holds the challenge of the Order Desk claim');
  }
  return null;
}

function handoffRef(loaded: Loaded): string | null {
  const handoff = loaded.carried?.result.handoff;
  return isObject(handoff) && typeof handoff.escrow_ref === 'string' ? handoff.escrow_ref : null;
}

function deskIn(loaded: Loaded): ReportedHire | undefined {
  const target = handoffRef(loaded);
  return loaded.hires.find((hire): hire is ReportedHire => hire.report !== null && hire.role === DESK && hire.entry.escrow_ref === target);
}

const deskOf = (a: Assembly): ReportedHire | undefined => deskIn(a.loaded);
const named = (a: Assembly, step: string): ReportedHire | undefined => a.loaded.hires.find((hire): hire is ReportedHire => hire.report !== null && hire.entry.step === step);

function paidOf(a: Assembly): VaultPayment {
  const paid = a.extra.paid;
  if (!isObject(paid) || typeof paid.paid !== 'boolean' || typeof paid.why !== 'string') throw new PreconditionError('the vault payment was not read');
  return { paid: paid.paid, why: paid.why };
}

function countOf(section: unknown): number | null {
  return isObject(section) && Array.isArray(section.orders) ? section.orders.length : null;
}

function claimOf(a: Assembly, agent: string): Obj {
  const c = a.facts.claims[a.loaded.record.label]![agent]!;
  return {
    claim_ref: c.claimRef, document_tx: c.documentTx, claim_tx: c.claimTx, claim_token: c.claimToken, stake_lovelace: c.stakeLovelace, window_ms: c.windowMs, staked_at: c.stakedAt,
    withdrawable_from: c.withdrawableFrom, withdraw_tx: c.withdrawTx,
  };
}

const hireRefs = (hire: HireView): Ref[] => [
  ref('transaction', hire.entry.post_tx), ref('escrow', hire.entry.escrow_ref),
  ...(hire.entry.accept_tx === null ? [] : [ref('transaction', hire.entry.accept_tx)]), ...(hire.entry.reclaim_tx === null ? [] : [ref('transaction', hire.entry.reclaim_tx)]),
];

const decisionEscrow = (hire: HireView, name: string): string | null => {
  const found = hire.decisions.find((one) => one.name === name);
  return found === undefined ? null : ((found.inference as Obj).sub_job as Obj).escrow_ref as string;
};

/** True when the log of the mock service holds an allowed call with this route and this kind of credential (and, for a token, this length of the act chain). */
function logHas(a: Assembly, route: string, credential: string, act: number | null): boolean {
  return (a.mock?.lines ?? []).some((line) => line.route === route && line.credential === credential && line.decision === 'allowed' && (act === null || (Array.isArray(line.act) && line.act.length === act)));
}

const refusalOf = (a: Assembly, step: string, kind: 'ledger' | 'tool'): boolean => a.loaded.record.refusals.some((one) => one.step === step && one.kind === kind);
const RULES: Readonly<Record<string, (a: Assembly) => Shown>> = {
  'r1-01': (a) => { const d = a.reads.delegations[0]; return d === undefined ? 'the record lists no delegation' : [ref('delegation', d.id), ref('transaction', d.tx)]; },
  'r1-02': (a) => { const v = a.reads.vaults[0]; return v === undefined ? 'the record lists no vault' : [ref('vault', v.ref), ref('transaction', v.open_tx)]; },
  'r1-03': (a) => { const h = named(a, 'propose'); return h === undefined ? 'the record has no hire named propose' : hireRefs(h); },
  'r1-04': (a) => {
    const s = a.reads.subDelegations[0];
    if (s === undefined) return 'the record lists no sub-delegation';
    return logHas(a, 'GET /erp/stock/{sku}', 'token', 2) ? [ref('delegation', s.id), ref('transaction', s.delegate_tx)] : 'the log of the mock service shows no allowed stock read with a token that has a chain of two links';
  },
  'r1-05': (a) => {
    const s = a.reads.subDelegations[0]; const h = named(a, 'propose'); const e = h === undefined ? null : decisionEscrow(h, 'reorder');
    return s === undefined || e === null ? 'there is no sub-delegation, or the result of propose has no decision named reorder' : [ref('escrow', e), ref('transaction', s.undelegate_tx)];
  },
  'r1-06': (a) => {
    const approval = a.approvalStates[0];
    return approval?.state !== 'active' ? 'the approval is not confirmed by a read' : [ref('attestation', approval.entry.attestation), ref('transaction', approval.entry.tx)];
  },
  'r1-07': (a) => (a.loaded.carried === null ? 'no hire of execute carried an order' : hireRefs(a.loaded.carried)),
  'r1-08': (a) => {
    const d = deskOf(a);
    if (d === undefined) return 'the record has no hire of the Order Desk for the carried hire of execute';
    const payment = paidOf(a);
    return payment.paid ? [ref('transaction', d.entry.post_tx), ref('escrow', d.entry.escrow_ref)] : `the chain does not show the Order Desk hire as paid from the vault: ${payment.why}`;
  },
  'r1-09': (a) => {
    const d = deskOf(a); const e = d === undefined ? null : decisionEscrow(d, 'availability');
    if (d === undefined || e === null) return 'the Order Desk hire is missing, or its result has no decision named availability';
    return logHas(a, 'POST /supplier/orders', 'x509-svid', null) ? [ref('escrow', d.entry.escrow_ref), ref('escrow', e)] : 'the log of the mock service shows no allowed order with an X.509 SVID';
  },
  'r1-10': (a) => {
    const d = deskOf(a); const c = a.loaded.carried; const e = c === null ? null : decisionEscrow(c, 'accept_delivery');
    if (d === undefined || d.entry.accept_tx === null || c === null || c.result.outcome !== 'completed' || e === null) return 'the Order Desk hire has no accept, or the carried result is not completed, or it has no decision named accept_delivery';
    return logHas(a, 'POST /po', 'token', 1) ? [ref('transaction', d.entry.accept_tx), ref('escrow', e)] : 'the log of the mock service shows no allowed purchase order with a token';
  },
  'r1-11': (a) => {
    const d = a.reads.delegations[0]; const v = a.reads.vaults[0];
    return d === undefined || d.ended_tx === null || v === undefined || v.close_tx === null ? 'the vault is not closed, or the delegation is not ended' : [ref('transaction', v.close_tx), ref('transaction', d.ended_tx)];
  },
  'r2-a': (a) => refused(a, 'execute-a', 'r2-a'),
  'r2-b': (a) => {
    const settled = named(a, 'execute-b1');
    return settled === undefined || settled.result.outcome !== 'completed' ? 'the record has no completed hire named execute-b1 (the settled order of step b)' : refused(a, 'execute-b2', 'r2-b');
  },
  'r2-c': (a) => {
    const c = a.challenge;
    return c === null || a.loaded.carried?.result.outcome !== 'disputed' ? 'no hire of execute ended disputed with a challenge' : [ref('claim', c.claim), ref('transaction', c.evidence), ref('challenge', c.challenge)];
  },
  'r2-d': (a) => {
    const c = a.caseRead;
    if (c === null || c.verdict === null) return 'the case has no verdict';
    if (c.verdict !== 'AuditorWins') return `the jury decided ${c.verdict}, and the Order Desk got no hold: the run needs a new claim and a new challenge`;
    if (c.hold === null) return 'the node shows no hold with the reason 64 on the Order Desk';
    const token = c.indexed?.case_token ?? c.listed?.case_token ?? null;
    const finalized = c.indexed?.finalized_tx ?? null;
    return [...(token === null ? [] : [ref('case', token)]), ...(finalized === null ? [] : [ref('transaction', finalized)]), ref('hold', c.hold.record_output)];
  },
  'r2-e': (a) => {
    const d = deskOf(a);
    if (d === undefined) return 'the record has no hire of the Order Desk for the carried hire of execute';
    const ended = a.lineages.get(d.entry.escrow_ref)?.finished === true && d.entry.accept_tx === null && d.entry.reclaim_tx === null;
    return ended ? [ref('escrow', d.entry.escrow_ref)] : 'the escrow of the Order Desk hire is not finished on the chain without an accept and without a reclaim';
  },
  'r2-f': (a) => { const p = named(a, 'propose-f'); return p === undefined || p.result.outcome !== 'failed' ? 'the record has no failed hire named propose-f' : hireRefs(p); },
  'r2-g': (a) => {
    const hold = a.facts.holds[a.loaded.record.label];
    return hold === undefined || hold.suspendTx === null || hold.liftTx === null ? 'the facts hold no hold and no lift of the run' : [ref('transaction', hold.suspendTx), ref('transaction', hold.liftTx)];
  },
  'r2-h': (a) => {
    const e = named(a, 'execute-h'); const ended = a.reads.delegations.find((d) => d.ended_tx !== null);
    if (e === undefined || e.result.outcome !== 'vault_refused' || e.result.exit_state !== 'Cancelled') return 'the record has no hire named execute-h that ended vault_refused and Cancelled';
    if (ended === undefined || ended.ended_tx === null) return 'no delegation of the record is ended';
    if (!refusalOf(a, 'r2-h', 'ledger') || !refusalOf(a, 'r2-h', 'tool')) return 'the record has no refusal of the ledger and no refusal of the tool for r2-h';
    return [ref('transaction', ended.ended_tx), ...hireRefs(e)];
  },
};

/** A step that a vault script refused: the hire that ended vault_refused, and the refusal of the ledger with its evaluation error and body. */
function refused(a: Assembly, step: string, id: string): Shown {
  const h = named(a, step);
  if (h === undefined || h.result.outcome !== 'vault_refused') return `the record has no hire named ${step} that ended vault_refused`;
  return refusalOf(a, id, 'ledger') ? hireRefs(h) : `the record has no refusal of the ledger for ${id}`;
}
export const inventory: EvidenceModule = {
  rules: RULES,
  runKinds: ['clean', 'failure'],
  hireRoles: HIRE_ROLES,
  agentOf: (role) => role === DESK ? [DESK] : role === 'propose' || role === 'execute' ? [REORDER] : [],
  reportOptional: [],
  readLegacy: true,
  reportSchemas: { propose: PROPOSAL_SCHEMA, execute: RESULT_SCHEMA, [DESK]: CONFIRMATION_SCHEMA },
  carriedOf(hires) {
    const carried = lastHire(hires, 'execute', (hire) => isObject(hire.result?.handoff));
    if (carried === undefined) throw new PreconditionError('no hire of execute carried an order to the Order Desk: the result of none holds a handoff');
    return carried.entry;
  },
  challengeOf,
  holdOf: (_a, source) => source.readRecordHold(),
  hireOfApproval: (a) => a.loaded.carried?.entry.step ?? null,
  approvalExpectations(a) {
    const digest = a.loaded.carried?.result.proposal_digest;
    if (typeof digest !== 'string' || !HASH.test(digest) || !a.loaded.hires.some((hire) => hire.role === 'propose' && hire.result?.proposal_digest === digest)) {
      throw new PreconditionError('no hire of propose holds the proposal_digest of the order that the carried hire of execute answers');
    }
    return { digest, maxValidityMs: RUN_APPROVAL_VALIDITY_MS, clockSlackMs: APPROVAL_CLOCK_SLACK_MS };
  },
  claimAgents: () => [REORDER, DESK],
  faultProblems(a) {
    if (a.loaded.record.kind !== 'failure') return [];
    const carriedPost = a.loaded.carried === null ? undefined : a.times.get(a.loaded.carried.entry.post_tx);
    const name = a.use.agents.find((agent) => agent.id === DESK)?.serviceContainer;
    const fault = a.faults.some((entry) => entry.ok && entry.check === 'confirm_wrong_lot' && entry.agent === DESK && carriedPost !== undefined && entry.atMs <= carriedPost
      && entry.services.some((service) => service.service === name && service.value === 'confirm_wrong_lot'));
    const problems = fault ? [] : [{ member: 'fault_check', detail: `no passing confirm_wrong_lot entry for the agent ${DESK} at or before the block time of the carried hire of execute` }];
    const confirmation = deskOf(a);
    if (confirmation !== undefined && confirmation.result.fault_mode !== 'confirm_wrong_lot') {
      problems.push({ member: `hires[${confirmation.index}].report_file`, detail: 'the confirmation of the Order Desk has not the fault_mode confirm_wrong_lot that the failure run needs' });
    }
    return problems;
  },
  hosted: [],
  async prepare(_session, a) {
    if (a.purpose !== 'run' || !a.use.evidenceSteps.some((step) => step.id === 'r1-08' && (step.run === a.loaded.record.kind || step.run === 'both'))) return {};
    const desk = deskOf(a);
    return { paid: desk === undefined ? { paid: false, why: 'the record has no hire of the Order Desk for the carried hire of execute' } : await a.paidFromVault(desk.entry) };
  },
  mockRoutes: ['GET /erp/stock/{sku}', 'POST /supplier/orders', 'POST /po'],
  counts(state) {
    const purchaseOrders = countOf(state.po_store);
    const supplierOrders = countOf(state.supplier);
    return purchaseOrders === null || supplierOrders === null ? null : { purchase_orders: purchaseOrders, supplier_orders: supplierOrders };
  },
  moduleDocument(a) {
    if (a.loaded.record.approvals.length !== 1 || a.loaded.record.approvals[0]?.role !== 'approval' || a.approvalStates[0]?.state !== 'active') {
      throw new PreconditionError('approval: the run needs exactly one active approval');
    }
    const checked = a.approvalStates[0];
    return {
      run: `use-case-1-${a.loaded.record.kind}`,
      approval: {
        attestation: checked.entry.attestation, tx: checked.entry.tx, type: checked.type, subject: checked.subject, digest: checked.digest, issued_at: checked.issued_at,
        valid_until: checked.valid_until, validity_ms: checked.validity_ms, checked_at: checked.checked_at,
      },
      sub_delegations: a.reads.subDelegations.map(({ id, delegate_tx, undelegate_tx }) => ({ id, delegate_tx, undelegate_tx })),
      claims: { reorder_agent: claimOf(a, REORDER), order_desk: claimOf(a, DESK) },
      fault_mode: { reorder_agent: a.loaded.carried?.result.fault_mode ?? '', order_desk: deskOf(a)?.result.fault_mode ?? '' },
    };
  },
};
