// scripts/operator/tasks/results.ts - the task `results`: the private page of a use case, made from the evidence files of its runs.
//
//   run --header-file <path> [--runs <label>,<label>]   prints the page (no --submit) or writes <state>/results/<use case>.md (--submit)
//   status                                              lists the evidence files and says whether the page exists
//
// The page has one table for each run: a row for each step of the data of the use case for the kind of the run, with the primitive that the step used, the reference that the evidence file holds
// for it, and what the step shows and does not show. The two sentences come from one table of this file, for each primitive of the data. A step counts as shown only when the evidence file holds a
// reference for it: a step with no reference and a step that did not run say so, and give no reference. The page starts with the text of the header file of the operator, verbatim. That text names
// the group that the results go to, and the name is in no file of the repository. The page ends with the section "Not covered".
// A label is the name of an evidence file without `.json`: the file `<state>/evidence/private/<label>.json`, or the file `<state>/evidence/<label>.json` (a public file has the date and the number
// of the run in its name). Without `--runs` the page takes the public labels only: a private file goes into the page when `--runs` names its label. The header file must lie outside the key folder,
// and it must hold no run of 40 or more hex characters and no line of the form NAME=value, which is a line of an env file: the value of such a line can be a token that is no hex. The task reads no key and
// no chain, signs nothing, and records no step in the state file, so it can run again when a later run adds a file.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { StepOutcome, TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { codeOf } from '../lib/registry.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import { holdsSecret } from '../lib/secrets.ts';

/** A transaction on the explorer of the network: this text and the hash. */
export const EXPLORER_TX = 'https://explorer.vector.mainnet.apexfusion.org/transaction/hash/';
/** The header file is refused above this size: it is a name and a few lines, and never a document. */
export const HEADER_LIMIT_BYTES = 8192;

const EVIDENCE_LIMIT_BYTES = 4 * 1024 * 1024;
const MOST_RUNS = 16;
const MOST_REFS = 32;
const MOST_NOTE_CHARS = 2000;
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PUBLIC_LABEL = /^(\d{4}-\d{2}-\d{2})-([a-z][a-z0-9-]{0,62})-run-[1-9][0-9]?$/;
const STEP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[0-9a-f]{64}$/;
const OUTPUT_REF = /^[0-9a-f]{64}#(?:0|[1-9]\d{0,5})$/;
const DID = /^did:vector:[0-9a-f]{64}$/;
const REF_VALUE = /^[A-Za-z0-9._:#/-]{1,200}$/;
const REF_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
/** A line of an env file: a name and an equals sign at the start of a line. A header names a group in plain words, so it holds no such line. */
const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*=/m;

// ---- what each primitive shows and does not show ----

export interface Sentences { readonly shows: string; readonly doesNotShow: string }

/**
 * One entry for each primitive that the data of the use case names (a test holds the keys to the data). `shows` says what a step with a reference proves. `doesNotShow` says what it leaves open. The
 * sentences are short, and they say no more than the reference can prove.
 */
export const SHOWS: Readonly<Record<string, Sentences>> = {
  'Delegation with a co-signature': {
    shows: 'The ledger holds a delegation from the hirer to the agent. The agent co-signed it.',
    doesNotShow: 'That the agent keeps to the limits of the delegation. The steps with a value limit test that.',
  },
  'Vault': {
    shows: 'The ledger holds a vault under the delegation. The vault holds funds of the hirer.',
    doesNotShow: 'That the vault refuses a payment above the limit. The steps with a value limit test that.',
  },
  'Escrow: post, claim, submit, accept': {
    shows: 'The hire settled through the escrow. The ledger holds the post, the claim, the submit and the accept.',
    doesNotShow: 'That the answer of the agent is right. The hirer checks the signed work record.',
  },
  'Sub-delegation, token exchange with the delegation chain': {
    shows: 'The agent gave its subagent one narrow right. The gateway issued a token for a chain of two delegations.',
    doesNotShow: 'That a token stops working after a delegation ends. Tests alone cover that case.',
  },
  'Model call from the marketplace, signed work record': {
    shows: 'A model from the marketplace made the decision. Its signed work record is on the ledger.',
    doesNotShow: 'That the decision is right. The model result is a sample, and another run can differ.',
  },
  'Attestation: approval': {
    shows: 'An approval attestation of the hirer is on the ledger. It names the digest of the proposal.',
    doesNotShow: 'That the hirer read the proposal. The attestation covers the digest only.',
  },
  'Escrow': {
    shows: 'The evidence names the escrow for the hire.',
    doesNotShow: 'That the work met the request or that the buyer accepted it.',
  },
  'Vault payment, agent hires agent': {
    shows: 'The agent paid the advert of the Order Desk from the vault of the hirer. The payment is inside the limit.',
    doesNotShow: 'That a payment above the limit fails. The failure run tests that.',
  },
  'Pre-claim check, X.509 SVID, model call': {
    shows: 'The Order Desk checked the handoff before it claimed the escrow. It proved its identity with an X.509 certificate. A model decided the availability.',
    doesNotShow: 'That the supplier portal is a real system. The portal is a mock service.',
  },
  'Receipt checks, accept, token for a route': {
    shows: 'The evidence records a completed hire, acceptance of the intake work and an allowed write to the route with a token.',
    doesNotShow: 'That the write reached a real system. The route is part of a mock service.',
  },
  'Vault close, undelegate': {
    shows: 'The ledger holds the close of the vault and the end of the delegation.',
    doesNotShow: 'That a system refuses a live token after the end. Tests alone cover that case.',
  },
  'Value limit of a vault': {
    shows: 'The vault script refused a payment above the limit when the node evaluated the transaction.',
    doesNotShow: 'That the limit suits the hirer. It shows only that the script holds the limit.',
  },
  'Module-1 challenge': {
    shows: 'The ledger records a challenge and its evidence.',
    doesNotShow: 'That the challenge is right. The jury decides that.',
  },
  'Module-1 verdict and hold': {
    shows: 'The recorded verdict puts a time-limited hold on the challenged agent.',
    doesNotShow: 'That another jury decides the same way. The jury result is a sample.',
  },
  'Escrow: release': {
    shows: 'The evidence records neither an accept nor a reclaim for this escrow.',
    doesNotShow: 'Whether the escrow ended, who spent it, or who received funds.',
  },
  'Hold removes the agent from the listing': {
    shows: 'The marketplace listing during the hold did not show the held agent.',
    doesNotShow: 'That the listing will show the advert again after the hold.',
  },
  'Proposal during a verified hold': {
    shows: 'The signed proposal during the hold names the other two Bid Desks and omits Bid Desk Charlie.',
    doesNotShow: 'Which adverts the marketplace listed at that time.',
  },
  'Hold and lift by a party': {
    shows: 'The Accountable key of the organisation put a hold on the Order Desk and lifted it.',
    doesNotShow: 'That another party can hold. It shows the Accountable party only.',
  },
  'End of a delegation, token refusal': {
    shows: 'After the hirer ended the delegation, the payment failed. The gateway refused a token request under that delegation.',
    doesNotShow: 'That a system that holds a live token refuses it after the end. Tests alone cover that case.',
  },
  'Delegation with a co-signature, attestation: principal binding, vault': {
    shows: 'The delegation, binding attestation and vault link the hirer to the agent.',
    doesNotShow: 'The private document or salt behind the binding digest.',
  },
  'Escrow, two sub-delegations, token exchange with the delegation chain, model call from the marketplace': {
    shows: 'The evidence links the proposal hire to two delegated reads and the model call for the justification.',
    doesNotShow: 'That the records or guideline came from real systems, or that the justification is correct.',
  },
  'Escrow, vault payment, agent hires agent': {
    shows: 'The execute hire led to a vault payment for a separate intake hire.',
    doesNotShow: 'That the insurer decided to cover the request.',
  },
  'Pre-claim check, attestation reads, JWT-SVID, model call': {
    shows: 'The intake evidence records the checks, the model decision and an allowed filing with a JWT identity.',
    doesNotShow: 'That the attestations were mandatory or that the request reached a real insurer.',
  },
  'Attestation: revoke and approve again, refusal before the claim, reclaim to a vault': {
    shows: 'The evidence links the revoked approval to a refusal and reclaim, and the linked approval to the later hire.',
    doesNotShow: 'That a new approval can change the old one or make it valid again.',
  },
  'Attestation: approval that ends, refusal before the claim': {
    shows: 'The approval had expired when the handoff was refused before the claim.',
    doesNotShow: 'That an expired approval was the cause of any other refusal.',
  },
  'Digest check of an approval, refusal before the claim': {
    shows: 'Intake refused the changed request before the claim. The mock system records no filing for it.',
    doesNotShow: 'That the check decides whether the request is medically correct.',
  },
  'End of the subagents, token refusal': {
    shows: 'The evidence ties the end transaction to revoked subagent resolutions and a refused token request.',
    doesNotShow: 'That a relying party stops accepting a token that it already holds.',
  },
  'Delegation with a co-signature, vault': {
    shows: 'The ledger records the co-signed delegation and the vault it authorizes.',
    doesNotShow: 'That the agent used or exhausted the vault limit.',
  },
  'Marketplace list, catalog and status list reads, model call from the marketplace': {
    shows: 'The evidence links the bidder facts to the model call for the shortlist.',
    doesNotShow: 'That every possible bidder was listed or that the shortlist is optimal.',
  },
  'Vault payment, pre-claim check, model call, accept': {
    shows: 'The evidence links three vault-paid quote hires to the checks, model decisions and accept transactions.',
    doesNotShow: 'That the quotes were the best available or that the agents guarantee delivery.',
  },
  'Three sub-delegations, token exchange with the delegation chain, model call': {
    shows: 'The evidence links three distinct delegated reads to the proposal and the model call for the ranking.',
    doesNotShow: 'That the ranking is optimal or that this model repeats it.',
  },
  'Escrow, token for a route': {
    shows: 'The execute hire and the allowed token write are recorded for this ranking.',
    doesNotShow: 'That the write made an award in a real procurement system.',
  },
  'Attestation: revoke and reply': {
    shows: 'The attestation is revoked. The bidder facts record the hash of its reply.',
    doesNotShow: 'That the reply restores the attestation or that either party is right.',
  },
  'Refusal by a system with no approval': {
    shows: 'The mock system refused the write when the request had no approval.',
    doesNotShow: 'That the system would refuse a valid approval or check the ranking itself.',
  },
  'Revoke of a record by a party': {
    shows: 'The evidence names the transaction and its record output.',
    doesNotShow: 'Which party authorized the transaction, the reason, or when signatures became invalid.',
  },
  'Change of the controller': {
    shows: 'The record shows the new controller after the change transaction.',
    doesNotShow: 'That this controller can recover the record without the required guardians.',
  },
  'Recovery start': {
    shows: 'The recorded recovery start names the next controller and when recovery can complete.',
    doesNotShow: 'That the recovery has completed.',
  },
  'Waiting time of a recovery': {
    shows: 'The tool refused to build a completion before the recovery window opened.',
    doesNotShow: 'That the ledger refused a submitted completion. None was submitted early.',
  },
  'Recovery completion': {
    shows: 'The completion after the wait put the next controller in control.',
    doesNotShow: 'That a recovery can bypass the waiting period.',
  },
  'Retire of a record': {
    shows: 'The record became a tombstone. The retire transaction left its deposit.',
    doesNotShow: 'That this transaction set a successor or reclaimed the deposit.',
  },
  'Successor of an ended record': {
    shows: 'The tombstone names the successor record.',
    doesNotShow: 'That the successor inherits a claim, delegation or advert.',
  },
  'Reclaim of an ended record': {
    shows: 'The reclaim took the deposit above the ledger minimum and left the tombstone.',
    doesNotShow: 'That this operation returns funds from a hire escrow.',
  },
};

// A use case can establish more than the generic wording, or preserve established wording for that case.
const CASE_SHOWS: Readonly<Partial<Record<UseCase['name'], Readonly<Record<string, Sentences>>>>> = {
  'inventory-reorder': {
    'Escrow': {
      shows: 'The hire settled through the escrow. The ledger holds each transaction of the escrow.',
      doesNotShow: 'That the order is right. The steps of the Order Desk show the order.',
    },
    'Receipt checks, accept, token for a route': {
      shows: 'The agent ran the receipt checks and accepted the work. It wrote the purchase order with a token for that route.',
      doesNotShow: 'That the store of purchase orders is a real system. It is a mock service.',
    },
    'Module-1 challenge': {
      shows: 'The agent challenged the claim of the Order Desk. The evidence is on the ledger.',
      doesNotShow: SHOWS['Module-1 challenge']!.doesNotShow,
    },
    'Module-1 verdict and hold': {
      shows: 'The jury decided. The Order Desk got a hold of 7 days with the reason 64.',
      doesNotShow: SHOWS['Module-1 verdict and hold']!.doesNotShow,
    },
    'Hold removes the agent from the listing': {
      shows: 'During the hold the marketplace listed no advert of the Order Desk. A new proposal found none.',
      doesNotShow: 'That the listing returns after the hold. The end-state check reads that.',
    },
  },
  'bid-evaluation': {
    'Escrow: release': {
      shows: 'The evidence records a confirmed Release spend of this quote escrow.',
      doesNotShow: 'Who submitted the transaction or how much the supplier received.',
    },
  },
};

/** The fixed texts of the page. A test strips these, the table above, the data and the evidence from a page, and finds nothing left. */
export const PAGE_TEXT = {
  results: 'results',
  intro: 'This page lists the steps of each run. A row names the primitive that the step used and the reference that the evidence file holds for it. A step counts as shown only when the evidence file holds a reference for it. A step that did not run says so and gives its reason.',
  run: 'Run',
  columns: ['id', 'what', 'primitive', 'reference', 'shows', 'does not show'],
  none: 'none',
  notRun: 'Not run.',
  noReason: 'The evidence file gives no reason.',
  noEntry: 'The evidence file has no entry for this step.',
  noReference: 'Not shown. The evidence file holds no reference for this step.',
  partialReference: 'Not shown in full. The evidence file does not support every part of this step.',
  wholeStep: 'The whole step.',
  notCovered: 'Not covered',
  limitsLead: 'The runs have these limits:',
  limitsItems: [
    'The model decisions are a sample. Another run can decide another way.',
    'The jury result is a sample. Another jury can decide another way.',
    'One operator holds the keys of the agents, and they sit on one host.',
  ],
} as const;

// ---- the evidence of a run, as the page reads it ----

/** A reference of a step: a plain text (a transaction hash when it is 64 hex characters) or a labelled value (`kind` and `value`). */
export interface Ref { readonly kind: string | null; readonly value: string }
export interface EvidenceStep { readonly id: string; readonly status: 'shown' | 'not_run'; readonly refs: readonly Ref[]; readonly note: string; readonly complete: boolean }
export interface PageRun { readonly label: string; readonly kind: string; readonly date: string; readonly steps: ReadonlyMap<string, EvidenceStep> }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One reference from the evidence file, or null when it has no valid form. */
function refOf(raw: unknown): Ref | null {
  if (typeof raw === 'string') return REF_VALUE.test(raw) ? { kind: null, value: raw } : null;
  if (!isObject(raw) || Object.keys(raw).length !== 2) return null;
  const { kind, value } = raw;
  if (typeof kind !== 'string' || typeof value !== 'string' || !REF_KIND.test(kind) || !REF_VALUE.test(value)) return null;
  return kind === 'transaction' && !HASH.test(value) ? null : { kind, value };
}

type Refusal = 'ledger' | 'tool' | 'projected-tool';
type RouteRead = readonly [route: string, credential: string, links: number | null, count?: number, decision?: 'refused'];
type ProjectedRoute = readonly [route: string, credential: 'token' | 'jwt-svid', decision: 'allowed' | 'refused', links: number, count: number, status: number];
interface StepProof {
  readonly refs: Readonly<Record<string, number>>;
  readonly refusals?: readonly Refusal[];
  readonly routes?: readonly RouteRead[];
  readonly projectedRoutes?: readonly ProjectedRoute[];
  readonly settlement?: { readonly type: 'receipt' } | { readonly type: 'none-recorded' } | { readonly type: 'release' } | { readonly type: 'intake-handoff' };
  readonly recordFromTransaction?: 'record' | 'hold';
}
interface CaseProof { readonly number: number; readonly steps: Readonly<Record<string, StepProof>> }

const HIRE = { transaction: 2, escrow: 1 } as const;
const CLOSE = { transaction: 2 } as const;
const APPROVAL = { attestation: 1, transaction: 1 } as const;
const VERDICT = { case: 1, transaction: 1, hold: 1 } as const;
const RECORD = { transaction: 1, record: 1 } as const;

/** Minimum distinct references for each row. The assembler checks the ledger and the actual operation; this task checks its saved evidence. */
const PROOF: Readonly<Record<string, CaseProof>> = {
  'inventory-reorder': { number: 1, steps: {
    'r1-01': { refs: { delegation: 1, transaction: 1 } },
    'r1-02': { refs: { vault: 1, transaction: 1 } },
    'r1-03': { refs: HIRE },
    'r1-04': { refs: { delegation: 1, transaction: 1 }, routes: [['GET /erp/stock/{sku}', 'token', 2]] },
    'r1-05': { refs: { escrow: 1, transaction: 1 } },
    'r1-06': { refs: APPROVAL },
    'r1-07': { refs: HIRE },
    'r1-08': { refs: { escrow: 1, transaction: 1 } },
    'r1-09': { refs: { escrow: 2 }, routes: [['POST /supplier/orders', 'x509-svid', null]] },
    'r1-10': { refs: { escrow: 1, transaction: 1 }, routes: [['POST /po', 'token', 1]], settlement: { type: 'receipt' } },
    'r1-11': { refs: CLOSE },
    'r2-a': { refs: HIRE, refusals: ['ledger'] },
    'r2-b': { refs: HIRE, refusals: ['ledger'] },
    'r2-c': { refs: { claim: 1, transaction: 1, challenge: 1 } },
    'r2-d': { refs: VERDICT },
    'r2-e': { refs: { escrow: 1 }, settlement: { type: 'none-recorded' } },
    'r2-f': { refs: HIRE },
    'r2-g': { refs: CLOSE },
    'r2-h': { refs: { transaction: 3, escrow: 1 }, refusals: ['ledger', 'tool'] },
  } },
  'prior-authorization': { number: 2, steps: {
    'r1-01': { refs: { delegation: 1, attestation: 1, vault: 1, transaction: 3 } },
    'r1-02': { refs: { escrow: 2, delegation: 2, transaction: 4 }, projectedRoutes: [
      ['GET /records/orders/{order_id}', 'token', 'allowed', 2, 1, 200], ['GET /guidelines/{code}', 'token', 'allowed', 2, 1, 200],
    ] },
    'r1-03': { refs: APPROVAL },
    'r1-04': { refs: { escrow: 2, transaction: 3, vault: 1 } },
    'r1-05': { refs: { escrow: 2, transaction: 1 }, projectedRoutes: [['POST /insurer/requests', 'jwt-svid', 'allowed', 0, 1, 201]] },
    'r1-06': { refs: { escrow: 1, transaction: 1 }, projectedRoutes: [['POST /records/orders/{order_id}/submission', 'token', 'allowed', 1, 1, 201]], settlement: { type: 'intake-handoff' } },
    'r1-07': { refs: CLOSE },
    'r2-d': { refs: { attestation: 2, escrow: 3, transaction: 6 } },
    'r2-e': { refs: { attestation: 1, escrow: 1, transaction: 2 } },
    'r2-a': { refs: { escrow: 2, transaction: 2 } },
    'r2-b': { refs: { claim: 1, challenge: 1 } },
    'r2-b-hold': { refs: VERDICT },
    'r2-c': { refs: { hold: 1, transaction: 1 }, refusals: ['projected-tool'], recordFromTransaction: 'hold' },
    'r2-f': { refs: { transaction: 1, did: 2, probe: 2 } },
  } },
  'bid-evaluation': { number: 3, steps: {
    'r1-01': { refs: { delegation: 1, vault: 1, transaction: 2 } },
    'r1-02': { refs: HIRE },
    'r1-03': { refs: { bidder: 3, escrow: 1 } },
    'r1-04': { refs: { escrow: 9, transaction: 6 } },
    'r1-05': { refs: { delegation: 3, transaction: 6, escrow: 1 }, projectedRoutes: [['GET /vendors', 'token', 'allowed', 2, 3, 200]] },
    'r1-06': { refs: APPROVAL },
    'r1-07': { refs: HIRE, projectedRoutes: [['POST /sourcing/rankings', 'token', 'allowed', 1, 1, 201]] },
    'r1-08': { refs: CLOSE },
    'r2-a': { refs: { escrow: 1, claim: 1, challenge: 1 } },
    'r2-a-release': { refs: { escrow: 1, transaction: 1 }, settlement: { type: 'release' } },
    'r2-a-hold': { refs: VERDICT },
    'r2-b': { refs: { attestation: 1, escrow: 1, transaction: 4 } },
    'r2-c': { refs: { escrow: 1, hold: 1, transaction: 2 } },
    'r2-d': { refs: HIRE, projectedRoutes: [['POST /sourcing/rankings', 'token', 'refused', 1, 1, 403]] },
    'r2-e': { refs: RECORD, recordFromTransaction: 'record' },
    'l1-01': { refs: RECORD },
    'l1-02': { refs: RECORD },
    'l1-03': { refs: CLOSE, refusals: ['tool'] },
    'l1-04': { refs: RECORD },
    'l1-05': { refs: RECORD },
    'l1-06': { refs: RECORD },
    'l1-07': { refs: RECORD },
  } },
};

/** The run record accepts a role followed by one short alphanumeric suffix. */
function hasHireRole(step: unknown, role: string): boolean {
  return typeof step === 'string' && (step === role || (step.startsWith(role) && /^-[a-z0-9]{1,8}$/.test(step.slice(role.length))));
}

/** An escrow must identify one hire. Two entries for one escrow cannot confirm the same action. */
function hireFor(hires: readonly unknown[], escrow: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const hire of hires) {
    if (!isObject(hire) || hire.escrow_ref !== escrow) continue;
    if (found !== null) return null;
    found = hire;
  }
  return found;
}

/** A publishable spend needs the assembler's terminal proof, not an empty Accept or Reclaim field. */
function releaseOf(refs: readonly Ref[], hires: readonly unknown[], proof: unknown): boolean {
  if (!isObject(proof) || Object.keys(proof).length !== 5 || proof.action !== 'Release') return false;
  const { escrow_ref: escrow, tx, spent_output: spent, at } = proof;
  if (typeof escrow !== 'string' || !OUTPUT_REF.test(escrow) || typeof tx !== 'string' || !HASH.test(tx)
      || typeof spent !== 'string' || !OUTPUT_REF.test(spent) || spent === escrow || spent.startsWith(`${tx}#`)
      || typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return false;
  if (refs.length !== 2 || !refs.some(({ kind, value }) => kind === 'escrow' && value === escrow)
      || !refs.some(({ kind, value }) => kind === 'transaction' && value === tx)) return false;
  const hire = hireFor(hires, escrow);
  return hire !== null && hasHireRole(hire.step, 'quote') && hire.post_tx === escrow.slice(0, 64)
    && hire.verdict === 'VERIFIED' && hire.accept_tx === null && hire.reclaim_tx === null;
}

/** The public assembler proof binds the signed handoff to the independently confirmed Accept without publishing the signed contents. */
function intakeHandoffOf(refs: readonly Ref[], hires: readonly unknown[], doc: Record<string, unknown>): boolean {
  const proof = doc.handoff_evidence;
  if (!isObject(proof) || Object.keys(proof).length !== 7) return false;
  const { execute_step: executeStep, execute_escrow: executeEscrow, execute_result_sha256: digest,
    intake_step: intakeStep, intake_escrow: intakeEscrow, signed_acceptance: signed, confirmed_accept_tx: accept } = proof;
  if (!hasHireRole(executeStep, 'execute') || !hasHireRole(intakeStep, 'intake') || typeof executeEscrow !== 'string' || !OUTPUT_REF.test(executeEscrow)
      || typeof intakeEscrow !== 'string' || !OUTPUT_REF.test(intakeEscrow) || intakeEscrow === executeEscrow
      || typeof digest !== 'string' || !HASH.test(digest) || typeof accept !== 'string' || !HASH.test(accept)
      || (signed !== 'confirmed' && signed !== 'pending')) return false;
  if (doc.escrow_ref !== executeEscrow || doc.result_sha256 !== digest || doc.verdict !== 'VERIFIED' || !isObject(doc.result_projection)
      || doc.result_projection.operation !== 'execute' || doc.result_projection.outcome !== 'completed' || doc.result_projection.exit_state !== 'Completed') return false;
  const execute = hireFor(hires, executeEscrow);
  const intake = hireFor(hires, intakeEscrow);
  return execute !== null && execute.step === executeStep && execute.result_sha256 === digest && execute.verdict === 'VERIFIED'
    && intake !== null && intake.step === intakeStep && intake.verdict === 'VERIFIED' && intake.reclaim_tx === null
    && typeof intake.result_sha256 === 'string' && HASH.test(intake.result_sha256) && intake.accept_tx === accept
    && refs.some(({ kind, value }) => kind === 'transaction' && value === accept);
}

/** The assembler's public links, receipt and check results must agree before a row claims an accepted, completed hire. */
function settlementOf(settlement: NonNullable<StepProof['settlement']>, refs: readonly Ref[], doc: Record<string, unknown>): boolean {
  const hires: unknown[] = Array.isArray(doc.hires) ? doc.hires : [];
  if (settlement.type === 'release') return releaseOf(refs, hires, doc.release);
  if (settlement.type === 'intake-handoff') return intakeHandoffOf(refs, hires, doc);
  if (settlement.type === 'none-recorded') {
    const matching = hires.filter((hire) => isObject(hire) && refs.some(({ kind, value }) => kind === 'escrow' && value === hire.escrow_ref));
    return matching.length === 1 && isObject(matching[0]) && matching[0].accept_tx === null && matching[0].reclaim_tx === null;
  }
  const { accept_tx: accept, escrow_ref: escrow, result_sha256: digest, result, receipt, receipt_signature: signature, checks } = doc;
  if (typeof accept !== 'string' || !HASH.test(accept) || typeof escrow !== 'string' || !OUTPUT_REF.test(escrow)
      || typeof digest !== 'string' || typeof result !== 'string' || createHash('sha256').update(result).digest('hex') !== digest
      || !isObject(receipt) || receipt.escrow_ref !== escrow || receipt.response_hash !== digest
      || typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature) || !isObject(checks)
      || checks.signature_valid !== 'pass' || checks.response_hash_matches !== 'pass' || checks.escrow_ref_matches !== 'pass' || checks.supplier_key_matches !== 'pass') return false;
  let body: unknown;
  try { body = JSON.parse(result); } catch { return false; }
  if (!isObject(body) || body.outcome !== 'completed' || !isObject(body.handoff)) return false;
  const { accepted, escrow_ref: handoff } = body.handoff;
  if (accepted !== 'confirmed' && accepted !== 'pending') return false;
  if (typeof handoff !== 'string' || !OUTPUT_REF.test(handoff) || handoff === escrow) return false;
  const carried = hireFor(hires, escrow);
  const received = hireFor(hires, handoff);
  if (carried === null || received === null || carried.accept_tx !== accept || carried.reclaim_tx !== null || carried.result_sha256 !== digest) return false;
  const { step, accept_tx: intakeAccept, reclaim_tx: intakeReclaim, result_sha256: intakeDigest, verdict } = received;
  if (!hasHireRole(step, 'order-desk')) return false;
  // The assembler confirms the Accept for this escrow independently of when the result was signed.
  return verdict === 'VERIFIED' && intakeReclaim === null && typeof intakeDigest === 'string' && HASH.test(intakeDigest)
    && typeof intakeAccept === 'string' && HASH.test(intakeAccept) && refs.some(({ kind, value }) => kind === 'transaction' && value === intakeAccept);
}

/** Attribution stays in the assembler. The reader checks its exact step proof against the sanitized events. */
function projectedRoutesOf(id: string, required: readonly ProjectedRoute[], doc: Record<string, unknown>): boolean {
  if (!Array.isArray(doc.route_evidence) || !isObject(doc.mock) || !Array.isArray(doc.mock.log)) return false;
  const proofs = (doc.route_evidence as unknown[]).filter((row): row is Record<string, unknown> => isObject(row) && row.step === id);
  if (proofs.length !== required.length) return false;
  const log: unknown[] = doc.mock.log;
  for (const [route, credential, decision, links, count, status] of required) {
    if (proofs.filter((row) => Object.keys(row).length === 6 && row.route === route && row.credential === credential
        && row.decision === decision && row.act_links === links && row.count === count).length !== 1) return false;
    let matched = 0;
    for (const row of log) {
      if (isObject(row) && Object.keys(row).length === 5 && row.route === route && row.credential === credential
          && row.decision === decision && row.status === status && typeof row.at === 'string'
          && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.at) && Number.isFinite(Date.parse(row.at))) matched += 1;
    }
    // Distinct verified calls can have identical public timestamps.
    if (matched < count) return false;
  }
  return true;
}

function proofOf(proof: StepProof | undefined, id: string, refs: readonly Ref[], doc: Record<string, unknown>): boolean {
  if (proof === undefined) return false;
  for (const [kind, count] of Object.entries(proof.refs)) {
    const values = new Set<string>();
    for (const ref of refs) {
      if (ref.kind !== kind) continue;
      const valid = kind === 'delegation' || kind === 'attestation' || kind === 'case' || kind === 'transaction' || kind === 'bidder' ? HASH.test(ref.value)
        : kind === 'did' ? DID.test(ref.value) : kind === 'probe' ? REF_VALUE.test(ref.value) : OUTPUT_REF.test(ref.value);
      if (valid) values.add(ref.value);
    }
    if (values.size < count) return false;
  }
  if (proof.settlement !== undefined && !settlementOf(proof.settlement, refs, doc)) return false;
  if (proof.projectedRoutes !== undefined && !projectedRoutesOf(id, proof.projectedRoutes, doc)) return false;
  if (proof.recordFromTransaction && !refs.some(({ kind, value }) => kind === proof.recordFromTransaction && OUTPUT_REF.test(value)
      && refs.some((one) => one.kind === 'transaction' && one.value === value.slice(0, 64)))) return false;
  if (proof.refusals !== undefined) {
    const refusals: unknown[] = Array.isArray(doc.refusals) ? doc.refusals : [];
    for (const kind of proof.refusals) {
      const projected = kind === 'projected-tool';
      if (!refusals.some((value) => isObject(value) && value.step === id && value.kind === (projected ? 'tool' : kind) && (projected
        ? typeof value.message_sha256 === 'string' && HASH.test(value.message_sha256)
        : kind === 'tool' ? typeof value.message === 'string' && value.message.trim() !== ''
          : typeof value.evaluation_error === 'string' && value.evaluation_error.trim() !== '' && typeof value.transaction_body === 'string' && value.transaction_body !== ''))) return false;
    }
  }
  if (proof.routes !== undefined) {
    const log: unknown[] = isObject(doc.mock) && Array.isArray(doc.mock.log) ? doc.mock.log : [];
    for (const [route, credential, links, count = 1, decision = 'allowed'] of proof.routes) {
      const rows = new Set<string>();
      for (const row of log) {
        if (!isObject(row) || row.route !== route || row.credential !== credential || row.decision !== decision
            || (links !== null && (!Array.isArray(row.act) || row.act.length !== links))) continue;
        rows.add(JSON.stringify([row.at, row.sub, row.delegation, row.act]));
      }
      if (rows.size < count) return false;
    }
  }
  return true;
}

/** The run of an evidence file. A file that is not the evidence of a run of this use case is a PreconditionError that names the file by its label and the rule that it breaks, never a value. */
export function parseEvidence(value: unknown, label: string, use: Pick<UseCase, 'name' | 'agents' | 'runs' | 'evidenceSteps'>): PageRun {
  const bad = (rule: string): Error => new PreconditionError(`the evidence file ${label} is not usable: ${rule}`);
  if (!isObject(value)) throw bad('it is not a JSON object');
  const { kind, date, steps } = value;
  if (typeof kind !== 'string' || !use.runs.some((run) => run.id === kind)) throw bad('kind is not the id of a run of the use case');
  const profile = Object.hasOwn(PROOF, use.name) ? PROOF[use.name] : undefined;
  if (profile === undefined || value.run !== `use-case-${profile.number}-${kind}` || (value.use_case !== undefined && value.use_case !== use.name)) {
    throw bad('run does not name this use case and run kind');
  }
  if (typeof value.capability_id !== 'string' || !use.agents.some(({ capability }) => capability === value.capability_id)) {
    throw bad('its capability is not a capability of this use case');
  }
  if (typeof date !== 'string' || !DATE.test(date) || Number.isNaN(Date.parse(date))) throw bad('date is not a date of the form YYYY-MM-DD');
  if (!Array.isArray(steps)) throw bad('steps is not a list');
  const allowed = new Set(use.evidenceSteps.filter((step) => step.run === kind || step.run === 'both').map((step) => step.id));
  const parsed = new Map<string, EvidenceStep>();
  steps.forEach((raw: unknown, index) => {
    const where = `steps[${index}]`;
    if (!isObject(raw)) throw bad(`${where} is not an object`);
    const { id, status, refs, note } = raw;
    if (typeof id !== 'string' || !STEP_ID.test(id)) throw bad(`${where}.id is not a step id`);
    if (!allowed.has(id)) throw bad(`${where}.id is not a step of a run of this kind`);
    if (parsed.has(id)) throw bad(`${where}.id repeats a step`);
    if (status !== 'shown' && status !== 'not_run') throw bad(`${where}.status is neither shown nor not_run`);
    if (!Array.isArray(refs) || refs.length > MOST_REFS) throw bad(`${where}.refs is not a list of at most ${MOST_REFS} references`);
    const list = refs.map(refOf);
    if (list.some((ref) => ref === null)) throw bad(`${where}.refs holds a value that is no reference`);
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MOST_NOTE_CHARS)) throw bad(`${where}.note is not a text of at most ${MOST_NOTE_CHARS} characters`);
    const text = typeof note === 'string' ? note : '';
    if (holdsSecret(id) || holdsSecret(text) || list.some((ref) => ref !== null && (holdsSecret(ref.value) || holdsSecret(ref.kind)))) throw bad(`${where} holds a mark of a secret`);
    const refs_ = list.filter((ref): ref is Ref => ref !== null);
    const proof = Object.hasOwn(profile.steps, id) ? profile.steps[id] : undefined;
    parsed.set(id, { id, status, refs: refs_, note: text, complete: status === 'shown' && proofOf(proof, id, refs_, value) });
  });
  if (holdsSecret(label) || holdsSecret(kind) || holdsSecret(date)) throw bad('it holds a mark of a secret');
  return { label, kind, date, steps: parsed };
}

// ---- the page ----

const cell = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/[\\|]/g, '\\$&');

function refText(ref: Ref): string {
  const link = (hash: string): string => `[\`${hash}\`](${EXPLORER_TX}${hash})`;
  if (ref.kind === null) return HASH.test(ref.value) ? link(ref.value) : `\`${ref.value}\``;
  return ref.kind === 'transaction' ? link(ref.value) : `${ref.kind} \`${ref.value}\``;
}

/** The six cells of the row of a step. Do not apply the step's full summary to partial evidence. */
function rowOf(step: UseCase['evidenceSteps'][number], found: EvidenceStep | undefined, overrides: Readonly<Partial<Record<string, Sentences>>> | undefined): string[] {
  if (!Object.hasOwn(SHOWS, step.primitive)) throw new PreconditionError(`the table of shows and does not show has no entry for the primitive of the step ${step.id}`);
  const text = overrides !== undefined && Object.hasOwn(overrides, step.primitive) ? overrides[step.primitive]! : SHOWS[step.primitive]!;
  const head = [step.id, cell(step.what), cell(step.primitive)];
  if (found === undefined) return [...head, PAGE_TEXT.none, `${PAGE_TEXT.notRun} ${PAGE_TEXT.noEntry}`, PAGE_TEXT.wholeStep];
  if (found.status === 'not_run') {
    return [...head, PAGE_TEXT.none, `${PAGE_TEXT.notRun} ${found.note === '' ? PAGE_TEXT.noReason : cell(found.note)}`, PAGE_TEXT.wholeStep];
  }
  if (found.refs.length === 0) return [...head, PAGE_TEXT.none, PAGE_TEXT.noReference, PAGE_TEXT.wholeStep];
  const references = found.refs.map(refText).join('; ');
  if (!found.complete) return [...head, references, PAGE_TEXT.partialReference, PAGE_TEXT.wholeStep];
  return [...head, references, text.shows, text.doesNotShow];
}

/** The page: the header, the title, one table for each run, and the section "Not covered". The header comes first and verbatim. */
export function renderPage(input: { header: string; use: Pick<UseCase, 'name' | 'title' | 'evidenceSteps' | 'notCovered'>; runs: readonly PageRun[] }): string {
  const { lead, items } = input.use.notCovered;
  const overrides = Object.hasOwn(CASE_SHOWS, input.use.name) ? CASE_SHOWS[input.use.name] : undefined;
  const body: string[] = [`# ${input.use.title}: ${PAGE_TEXT.results}`, '', PAGE_TEXT.intro, ''];
  for (const run of input.runs) {
    body.push(`## ${PAGE_TEXT.run} ${run.label}: ${run.kind}, ${run.date}`, '', `| ${PAGE_TEXT.columns.join(' | ')} |`, `|${PAGE_TEXT.columns.map(() => '---').join('|')}|`);
    for (const step of input.use.evidenceSteps.filter((spec) => spec.run === run.kind || spec.run === 'both')) {
      body.push(`| ${rowOf(step, run.steps.get(step.id), overrides).join(' | ')} |`);
    }
    body.push('');
  }
  body.push(`## ${PAGE_TEXT.notCovered}`, '', lead, '', ...items.map((item) => `- ${item}`), '', PAGE_TEXT.limitsLead, '', ...PAGE_TEXT.limitsItems.map((item) => `- ${item}`));
  return `${input.header}${input.header.endsWith('\n') ? '' : '\n'}\n${body.join('\n')}\n`;
}

// ---- the files ----

/** True when `path` is `base` or lies below it. Both are real paths. */
function isInside(path: string, base: string): boolean {
  const way = relative(base, path);
  return way === '' || !(way === '..' || way.startsWith(`..${sep}`) || isAbsolute(way));
}

/**
 * The text of the header file, verbatim. These are refused: a link, a folder, a device, a file of the key folder (by its real path, so that a link to the folder does not hide it, and before the file is
 * read), a file above the limit, a file that is not UTF-8 text, a file with no text in it, a text with a mark of a secret or with 40 or more hex characters in a row (the size of a key, a hash or a token),
 * and a text with a line of the form NAME=value (a line of an env file, whose value can be a token that is no hex). A refusal never shows the text.
 */
function readHeader(path: string, keysDir: string): string {
  let found: Stats;
  try { found = lstatSync(path); } catch (err) { throw new PreconditionError(`the header file cannot be read (${codeOf(err)})`); }
  if (!found.isFile()) throw new PreconditionError('the header file is not a regular file: a link, a folder or a device is refused');
  let real: string;
  try { real = realpathSync(path); } catch (err) { throw new PreconditionError(`the header file cannot be read (${codeOf(err)})`); }
  let keys: string | null = null;
  try { keys = realpathSync(keysDir); } catch (err) {
    if (codeOf(err) !== 'ENOENT') throw new PreconditionError(`the key folder cannot be checked (${codeOf(err)})`);
  }
  if (keys !== null && isInside(real, keys)) throw new PreconditionError('the header file is inside the key folder: a file of that folder is no header, and the page shows the header');
  if (found.size > HEADER_LIMIT_BYTES) throw new PreconditionError(`the header file is larger than ${HEADER_LIMIT_BYTES} bytes: it holds a name and a few lines, and no document`);
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch (err) { throw new PreconditionError(`the header file cannot be read (${codeOf(err)})`); }
  if (bytes.length > HEADER_LIMIT_BYTES) throw new PreconditionError(`the header file is larger than ${HEADER_LIMIT_BYTES} bytes: it holds a name and a few lines, and no document`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new PreconditionError('the header file is not UTF-8 text'); }
  if (text.includes('\0')) throw new PreconditionError('the header file is not text: it holds a NUL character');
  if (text.trim() === '') throw new PreconditionError('the header file holds no text: it names the group that the results go to');
  if (/[0-9a-fA-F]{40,}/.test(text)) throw new PreconditionError('the header file holds 40 or more hex characters in a row: that is the size of a key, a hash or a token, and the header names a group');
  if (holdsSecret(text)) throw new PreconditionError('the header file holds a mark of a secret: the page holds no key and no token');
  if (ENV_LINE.test(text)) throw new PreconditionError('the header file holds a line of the form NAME=value: that is a line of an env file, and the header names a group in plain words');
  return text;
}

interface Found { readonly label: string; readonly path: string; readonly folder: 'public' | 'private' }

/** The evidence writer uses longer names for public files of some agents. Private labels keep their own limit. */
function publicLabel(label: string, use: Pick<UseCase, 'agents'>): boolean {
  const match = PUBLIC_LABEL.exec(label);
  if (match === null || !use.agents.some(({ id }) => id === match[2])) return false;
  const day = Date.parse(match[1]!);
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === match[1];
}

/** The evidence files of the state folder by label: the public files of `evidence/` and the private files of `evidence/private/`. A name that is no label, a link and two files with one label are refused. */
function listEvidence(stateDir: string, use: Pick<UseCase, 'agents'>): Map<string, Found> {
  const found = new Map<string, Found>();
  for (const folder of ['public', 'private'] as const) {
    const dir = folder === 'public' ? join(stateDir, 'evidence') : join(stateDir, 'evidence', 'private');
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) {
      if (codeOf(err) === 'ENOENT') continue;
      throw new PreconditionError(`the ${folder} evidence folder cannot be read (${codeOf(err)})`);
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith('.') || !entry.name.endsWith('.json')) continue;
      if (!entry.isFile()) throw new PreconditionError(`a ${folder} evidence file is not a regular file: a link or a folder is refused`);
      const label = entry.name.slice(0, -'.json'.length);
      if (!LABEL.test(label) && !(folder === 'public' && publicLabel(label, use))) {
        throw new PreconditionError(`the name of a ${folder} evidence file is no label: use a short label or the standard public file name of an agent`);
      }
      if (found.has(label)) throw new PreconditionError(`two evidence files have the label ${label}: keep one`);
      found.set(label, { label, path: join(dir, entry.name), folder });
    }
  }
  return found;
}

function readEvidence(file: Found): unknown {
  let found: Stats;
  try { found = lstatSync(file.path); } catch (err) { throw new PreconditionError(`the evidence file ${file.label} cannot be read (${codeOf(err)})`); }
  if (!found.isFile() || found.size > EVIDENCE_LIMIT_BYTES) throw new PreconditionError(`the evidence file ${file.label} is not a regular file of at most ${EVIDENCE_LIMIT_BYTES} bytes`);
  try { return JSON.parse(readFileSync(file.path, 'utf8')); } catch (err) {
    throw new PreconditionError(err instanceof SyntaxError ? `the evidence file ${file.label} is not JSON` : `the evidence file ${file.label} cannot be read (${codeOf(err)})`);
  }
}

function loadRuns(files: ReadonlyMap<string, Found>, wanted: readonly string[] | null, use: UseCase): PageRun[] {
  const labels = wanted ?? [...files.values()].filter((file) => file.folder === 'public').map((file) => file.label);
  if (labels.length === 0) throw new PreconditionError('there is no public evidence file: run the task evidence first, or name a private label with --runs');
  const runs = labels.map((label) => {
    const file = files.get(label);
    if (file === undefined) throw new PreconditionError(`there is no evidence file for the label ${label}: the evidence folders hold ${[...files.keys()].join(', ') || 'no file'}`);
    return parseEvidence(readEvidence(file), label, use);
  });
  return wanted === null ? runs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0)) : runs;
}

// ---- the task ----

interface PageSummary { readonly labels: readonly string[]; readonly file: string; readonly bytes: number; readonly sha256: string; readonly written: boolean }

interface ResultsExtra {
  readonly headerFile: string | null;
  readonly runs: readonly string[] | null;
  /** What the last run made, for the machine line. */
  page: PageSummary | null;
}

const pageFile = (use: Pick<UseCase, 'name'>): string => join('results', `${use.name}.md`);

async function produce(session: TaskSession<ResultsExtra>): Promise<StepOutcome> {
  const { extra, use } = session;
  if (extra.headerFile === null) throw new FlagError('--header-file is required: the page names the group that the results go to, and that name comes from a text file of the operator');
  const header = readHeader(extra.headerFile, session.settings.keysDir);
  const runs = loadRuns(listEvidence(session.settings.stateDir, use), extra.runs, use);
  const page = renderPage({ header, use, runs });
  if (holdsSecret(page)) throw new PreconditionError('the page holds a mark of a secret: it is not shown and not written');
  const bytes = Buffer.byteLength(page, 'utf8');
  const sha256 = createHash('sha256').update(page, 'utf8').digest('hex');
  const written = session.mode === 'submit';
  if (!written) for (const line of page.split('\n').slice(0, -1)) session.out.out(line);
  if (written) writeFileAtomically(join(session.settings.stateDir, pageFile(use)), page);
  extra.page = { labels: runs.map((run) => run.label), file: pageFile(use), bytes, sha256, written };
  return {
    kind: 'done',
    message: written
      ? `the page of ${runs.length} run(s) is written to ${pageFile(use)} in the state folder (${bytes} bytes, SHA-256 ${sha256})`
      : `dry run: the page above is not written (${bytes} bytes, SHA-256 ${sha256}). Run again with --submit to write it to ${pageFile(use)}`,
  };
}

const results: TaskDefinition<ResultsExtra> = {
  name: 'results',
  title: 'Writes the private results page of the use case from the evidence files of its runs.',
  flags: [],
  valued: ['header-file', 'runs'],
  needs: { keys: () => [], chain: false, hosted: [], approval: 'never' },
  steps: () => ['run'],
  parse(_env, _settings, use, flags) {
    const headerFile = flags.value('header-file');
    if (headerFile === '') throw new FlagError('--header-file needs the path of a text file');
    const list = flags.value('runs');
    let labels: string[] | null = null;
    if (list !== undefined) {
      labels = list.split(',');
      if (labels.length > MOST_RUNS || labels.some((label) => !LABEL.test(label) && !publicLabel(label, use))) {
        throw new FlagError(`--runs needs at most ${MOST_RUNS} comma-separated labels: short labels or public file names of agents`);
      }
      if (new Set(labels).size !== labels.length) throw new FlagError('--runs names a label twice');
    }
    return { headerFile: headerFile ?? null, runs: labels, page: null };
  },
  next: (session) => runSteps(session, [{ name: 'run', run: produce }]),
  cleanup: async () => ({ kind: 'done', message: 'the task results makes a page and takes nothing back' }),
  async status(session) {
    const where = pageFile(session.use);
    let files: ReadonlyMap<string, Found>;
    try { files = listEvidence(session.settings.stateDir, session.use); } catch (err) { return [`evidence files: cannot list them (${err instanceof Error ? err.message : 'an error'})`]; }
    const labels = [...files.values()].map((file) => `${file.label} (${file.folder})`);
    let page: string;
    try { page = `${where} exists, ${lstatSync(join(session.settings.stateDir, where)).size} bytes`; } catch { page = `${where} does not exist yet`; }
    return [`evidence files: ${labels.length === 0 ? 'none' : labels.join(', ')}`, `page: ${page}`];
  },
  result: (session) => (session.extra.page === null ? {} : { ...session.extra.page, labels: [...session.extra.page.labels] }),
};

export default results;
