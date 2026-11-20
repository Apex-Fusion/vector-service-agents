// packages/usecase-kit/test/dispute/support.ts
// The samples that the tests of the dispute folder share, and a scripted chain port. Every value has the form that the protocol names. No value is a key or a real reference.
import { documentHash, documentUri } from '@vsa/buyer-core';
import { canonicalSha256 } from '@vsa/usecase-kit/protocol';
import { Dispute, claimDocument, evidenceDocument } from '@vsa/usecase-kit/dispute';
import type {
  ChallengeView, ClaimView, DisputeJournal, DisputeSettings, DocumentAbsent, DocumentResult, Module1Port, OpenChallengeCall, OpenedChallenge, PublishCall, PublishedDocument, ReadDocument, ServiceQueue,
  SubmittedClaim, SubmitClaimCall, TxResult, WithdrawClaimCall, WithdrawnClaim,
} from '@vsa/usecase-kit/dispute';

export const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The canonical SHA-256 of a JSON value, as a confirmation names the purchase order that it answers. */
export function canonical(value: unknown): string {
  const digest = canonicalSha256(value, 'value');
  if (!digest.ok) throw new Error(digest.detail);
  return digest.value;
}

/** The settings of a test. The resolution deadline is not here: it comes from the port. */
export const SETTINGS: DisputeSettings = { challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 10 * 60_000, read_timeout_ms: 30_000 };

/** A wait that never ends: a bound that never fires. */
export const never = (): Promise<never> => new Promise<never>(() => undefined);

export const ME_ID = 'a1'.repeat(32);
export const ME = `did:vector:${ME_ID}`;
export const OTHER_ID = 'c1'.repeat(32);
export const OTHER = `did:vector:${OTHER_ID}`;
export const THIRD_ID = 'd3'.repeat(32);
export const THIRD = `did:vector:${THIRD_ID}`;
export const HIRER = `did:vector:${'b2'.repeat(32)}`;
export const BID_DESK = `did:vector:${'f7'.repeat(32)}`;
export const KEY_HASH = '0b'.repeat(28);
export const OTHER_KEY_HASH = '0c'.repeat(28);

export const TOKEN_A = `636c6d5f${'0a'.repeat(28)}`;
export const TOKEN_B = `636c6d5f${'0b'.repeat(28)}`;
export const TOKEN_C = `636c6d5f${'0c'.repeat(28)}`;
export const ESCROW = `${'e5'.repeat(32)}#1`;
export const ESCROW_2 = `${'e6'.repeat(32)}#1`;
export const REF_A = `${'ca'.repeat(32)}#0`;
export const REF_B = `${'cb'.repeat(32)}#0`;
export const REF_C = `${'cc'.repeat(32)}#2`;
export const EVIDENCE_TX = '77'.repeat(32);
export const CLAIM_DOC_TX = '88'.repeat(32);
export const CHALLENGE_TX = '99'.repeat(32);
export const MANIFEST_SHA = '5a'.repeat(32);
export const CHALLENGE_TOKEN = `63686c5f${'0e'.repeat(28)}`;

/** The capability that the claim documents of the samples are for, and the time that the job of the samples began: half an hour ago, after the claims of the samples were staked. */
export const CAPABILITY = 'supplychain.order.accept.v1';
export const JOB_BEGAN_AT = NOW - 30 * 60_000;

// --- The statements of three agents -----------------------------------------------------------------------------------------------------------------------------------

const statements = (...texts: [string, string, string]) => ({ statements: [{ id: 'S1', text: texts[0] }, { id: 'S2', text: texts[1] }, { id: 'S3', text: texts[2] }] }) as const;

export const ORDER_DESK_CLAIM = statements(
  'A confirmation that this agent signs names the SKU, the lot and the quantity of the purchase order that it answers.',
  'This agent places one order for each purchase order number.',
  'This agent takes a purchase order only with a valid approval of the buyer whose delegation paid for it.',
);
export const PRIOR_AUTHORIZATION_CLAIM = statements(
  'A request that this agent submits is byte-identical to the document whose digest its hirer approved.',
  'The record set hash in a request is the hash of the set that its drafter was given.',
  'This agent reads records and guidelines only through its subagents, each with its own token under its own sub-delegation.',
);
export const BID_DESK_CLAIM = statements(
  'The unit price of every line in a quote is the price that its published price list gives for that SKU and quantity.',
  'A quote names the hash of the request for quotation that it answers.',
  'This agent gives one quote for each request for quotation and sender.',
);

/** The claim document that this kit writes for `claimer`: the statements of the order desk, and the manifest of the samples. */
export function kitClaimDocument(claimer: string) {
  const document = claimDocument({ agent_did: claimer, capability_id: CAPABILITY, manifest_sha256: MANIFEST_SHA, claim: ORDER_DESK_CLAIM });
  if (!document.ok) throw new Error(document.detail);
  return document.value;
}

/** A claim that is open and was submitted one hour ago with a window of four hours. Its document is the claim document that this kit writes for the claimer, and its URI names the transaction of the claim. `overrides` change members. */
export function claimView(overrides: Partial<ClaimView> = {}): ClaimView {
  const base = {
    ref: REF_A, token: TOKEN_A, claimer: OTHER, claimer_key_hash: OTHER_KEY_HASH, state: 'Open', stake_lovelace: 50_000_000n, submitted_at: NOW - HOUR, challenge_window_ms: 4 * HOUR,
    claim_type: 'service-quality', ...overrides,
  } as const;
  return { claim_hash: kitClaimDocument(base.claimer).hash, claim_uri: documentUri(base.ref.split('#')[0]!), ...base };
}

// --- The evidence of the three use cases ------------------------------------------------------------------------------------------------------------------------------

/** The statement S1 of a reorder agent: the claim that the evidence of an approval of use case 1 is about. */
export const REORDER_AGENT_S1 = 'An order that this agent places is the purchase order whose digest its hirer approved.';

/** The text of the statement S1 of the claim document of the samples: the statement that the evidence is about. */
export const STATEMENT_S1 = ORDER_DESK_CLAIM.statements[0].text;

/** The job that the claims of the samples cover: the capability that they are for, the statement S1 of their claim document, and the time that the job began. */
export const JOB = { capability_id: CAPABILITY, statement_text: STATEMENT_S1, job_began_at: JOB_BEGAN_AT } as const;

export const PARTIES = { claim: REF_A, claim_token: TOKEN_A, against_did: OTHER, by_did: ME, escrow_ref: ESCROW, statement_text: STATEMENT_S1 } as const;

export const PURCHASE_ORDER = {
  schema: 'vector.usecase.po.v1', po_number: 'run1-0001', tenant: 'run1', sku: 'SKU-100', lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01', supplier_did: OTHER, advert_ref: REF_B,
} as const;

/** The canonical SHA-256 of `PURCHASE_ORDER`: the confirmation of the order desk names the purchase order that it answers by this hash. A test pins it against `canonicalSha256`. */
export const PURCHASE_ORDER_SHA = '3cd0eded21242ff660885bccdffc84de8a23c7362d84c3a6a20776e0a594c611';

export const CONFIRMATION = {
  schema: 'vector.usecase.order-confirmation.v1', outcome: 'done', po_number: 'run1-0001', po_sha256: PURCHASE_ORDER_SHA, sku: 'SKU-100', lot: 'lot-large', quantity: 120, ship_by: '2026-11-28',
  order_id: 'ORD-77',
} as const;

export const ORDER_FACTS = { kind: 'order_confirmation', purchase_order: PURCHASE_ORDER, confirmation: CONFIRMATION, confirmation_sha256: '33'.repeat(32) } as const;

export const QUOTE_FACTS = {
  kind: 'quote_price', sku: 'SKU-200', quantity: 100, quoted_unit_price: 110, listed_unit_price: 125, price_list_sha256: '66'.repeat(32), quote_sha256: '67'.repeat(32),
} as const;

export const MISMATCH = {
  ok: false, code: 'approval_digest_mismatch', detail: 'the digest of the approval is not the digest of the document and the salt that were received', expected_digest: 'e1'.repeat(32),
  observed_digest: 'e2'.repeat(32),
} as const;

export const APPROVAL = { attestation: '22'.repeat(32), issuer_did: HIRER } as const;

export const DIGEST_FACTS = { kind: 'approval_digest', use_case: 'prior-authorization', approval: APPROVAL, mismatch: MISMATCH } as const;

// --- A scripted chain port --------------------------------------------------------------------------------------------------------------------------------------------

const ok = <T>(value: T): TxResult<T> => ({ ok: true, value });

/** The calls that a port got and the jobs that the queue ran, in order, in one list. */
export type Events = string[];

/** A promise that the test settles by hand. (Promise.withResolvers is not in the types of this package's target.) */
export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** What a scripted port answers for a transaction: a result, or a promise of one that a test settles later. */
export type Answer<T> = TxResult<T> | Promise<TxResult<T>>;

/** A queue that runs one job at a time and writes `queue:start` and `queue:end` to the events. */
export class RecordingQueue {
  constructor(readonly events: Events) {}
  async run<T>(job: () => Promise<T>): Promise<T> {
    this.events.push('queue:start');
    try {
      return await job();
    } finally {
      this.events.push('queue:end');
    }
  }
}

/** What a read of a document answers when the source does not have the transaction of the document, and when the transaction carries no document. */
export const NO_TRANSACTION: DocumentAbsent = { ok: false, code: 'transaction_unknown', detail: 'the source does not have the transaction of the document' };
export const NO_DOCUMENT: DocumentAbsent = { ok: false, code: 'no_document', detail: 'the transaction carries no document' };

/** A chain port that answers from lists that a test sets, and that writes each call to the events. A test changes an answer by setting the member of the same name. */
export class ScriptedPort implements Module1Port {
  readonly agent = { did: ME, key_hash: KEY_HASH };
  readonly protocol = { resolution_deadline_ms: 72 * HOUR };
  claims: ClaimView[] = [];
  challenges: ChallengeView[] = [];
  /** The documents by URI. The default answer of `readDocumentAnswer` reads this first, and then the claim documents of `claims`. */
  documents = new Map<string, ReadDocument>();
  readClaimsFails: Error | null = null;
  readChallengesFails: Error | null = null;
  /** What `readClaim` answers. The default finds the claim by its ref in `claims`. */
  readClaimAnswer: (ref: string) => ClaimView | null | Error = (ref) => this.claims.find((claim) => claim.ref === ref) ?? null;
  /** What `readDocument` answers: a document, the absence of one, or an error for a source that fails. The default is the claim document that this kit writes for the claim with this URI. */
  readDocumentAnswer: (uri: string) => ReadDocument | DocumentAbsent | Error = (uri) => {
    const named = this.documents.get(uri);
    if (named !== undefined) return named;
    const claim = this.claims.find((candidate) => candidate.claim_uri === uri);
    if (claim === undefined) return new Error('no document at this address');
    return { bytes: kitClaimDocument(claim.claimer).bytes, type: 'claim', media_type: 'text/plain' };
  };
  /** What `isIndexed` answers: the source of the documents has each claim, unless a test says that it is behind or that it fails. */
  isIndexedAnswer: (ref: string) => boolean | Error = () => true;
  publishAnswer: (call: PublishCall) => Answer<PublishedDocument> = (call) => ok({ tx_hash: EVIDENCE_TX, uri: documentUri(EVIDENCE_TX), document_hash: documentHash(call.bytes), fee_lovelace: 200_000n });
  submitClaimAnswer: (call: SubmitClaimCall) => Answer<SubmittedClaim> = (call) =>
    ok({ tx_hash: CHALLENGE_TX, claim: REF_C, claim_token: TOKEN_C, stake_lovelace: call.stake_lovelace, submitted_at: NOW, challenge_window_ms: call.challenge_window_ms, fee_lovelace: 500_000n });
  openChallengeAnswer: (call: OpenChallengeCall) => Answer<OpenedChallenge> = (call) =>
    ok({
      tx_hash: CHALLENGE_TX, challenge: `${CHALLENGE_TX}#0`, challenge_token: CHALLENGE_TOKEN, claim: call.claim, claim_token: call.claim_token, stake_lovelace: call.stake_lovelace,
      deadline: NOW + call.resolution_deadline_ms, fee_lovelace: 700_000n,
    });
  withdrawAnswer: (call: WithdrawClaimCall) => Answer<WithdrawnClaim> = (call) =>
    ok({ tx_hash: CHALLENGE_TX, claim: call.claim, claim_token: call.claim_token, payout: `${CHALLENGE_TX}#0`, stake_lovelace: 50_000_000n, fee_lovelace: 400_000n });

  /** The calls with their arguments, for a test that looks at what was sent. */
  readonly published: PublishCall[] = [];
  readonly submitted: SubmitClaimCall[] = [];
  readonly challenged: OpenChallengeCall[] = [];
  readonly withdrawn: WithdrawClaimCall[] = [];

  constructor(readonly events: Events = []) {}

  /** Makes the publish wait until the function that this returns is called, and then answers as before. It shows what happens while the evidence is not confirmed. */
  holdPublish(): () => void {
    const answer = this.publishAnswer;
    const gate = deferred<void>();
    this.publishAnswer = async (call) => {
      await gate.promise;
      return answer(call);
    };
    return gate.resolve;
  }

  async readClaims(): Promise<readonly ClaimView[]> {
    this.events.push('readClaims');
    if (this.readClaimsFails !== null) throw this.readClaimsFails;
    return this.claims;
  }

  async readClaim(ref: string): Promise<ClaimView | null> {
    this.events.push(`readClaim ${ref}`);
    const answer = this.readClaimAnswer(ref);
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async readChallenges(): Promise<readonly ChallengeView[]> {
    this.events.push('readChallenges');
    if (this.readChallengesFails !== null) throw this.readChallengesFails;
    return this.challenges;
  }

  async readDocument(uri: string): Promise<DocumentResult> {
    this.events.push(`readDocument ${uri}`);
    const answer = this.readDocumentAnswer(uri);
    if (answer instanceof Error) throw answer;
    // A test gives a document in its plain form, or the absence of one in the form of the port.
    return typeof answer === 'object' && answer !== null && 'ok' in answer ? answer : { ok: true, value: answer as ReadDocument };
  }

  async isIndexed(ref: string): Promise<boolean> {
    this.events.push(`isIndexed ${ref}`);
    const answer = this.isIndexedAnswer(ref);
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async publishDocument(call: PublishCall): Promise<TxResult<PublishedDocument>> {
    this.events.push(`publish ${call.type}`);
    this.published.push(call);
    return this.publishAnswer(call);
  }

  async submitClaim(call: SubmitClaimCall): Promise<TxResult<SubmittedClaim>> {
    this.events.push('submitClaim');
    this.submitted.push(call);
    return this.submitClaimAnswer(call);
  }

  async openChallenge(call: OpenChallengeCall): Promise<TxResult<OpenedChallenge>> {
    this.events.push(`openChallenge ${call.claim}`);
    this.challenged.push(call);
    return this.openChallengeAnswer(call);
  }

  async withdrawClaim(call: WithdrawClaimCall): Promise<TxResult<WithdrawnClaim>> {
    this.events.push(`withdrawClaim ${call.claim}`);
    this.withdrawn.push(call);
    return this.withdrawAnswer(call);
  }
}

/** A dispute over a scripted port, and what a test needs to look at it. */
export interface Rig {
  readonly events: Events;
  readonly port: ScriptedPort;
  readonly dispute: Dispute;
  readonly logs: string[];
  /** The clock of the dispute: a test moves `now`. */
  readonly time: { now: number };
}

/** What a rig can take instead of its defaults. */
export interface RigOptions {
  readonly journal?: DisputeJournal;
  /** The list that the port and the queue write their calls to: a test that wraps another port, such as a journal, writes to the same list. */
  readonly events?: Events;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly queue?: ServiceQueue;
  readonly port?: ScriptedPort;
  readonly log?: (line: string) => void;
}

/** A dispute over a scripted port, a queue that writes to the events, a clock that a test moves, a sleep that never ends, and a log that keeps its lines. `settings` change the settings of the samples. */
export function rig(settings: Partial<DisputeSettings> = {}, options: RigOptions = {}): Rig {
  const events: Events = options.events ?? [];
  const port = options.port ?? new ScriptedPort(events);
  const time = { now: NOW };
  const logs: string[] = [];
  const dispute = new Dispute({
    port, queue: options.queue ?? new RecordingQueue(events), clock: () => time.now, sleep: options.sleep ?? never, log: options.log ?? ((line) => logs.push(line)), settings: { ...SETTINGS, ...settings },
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  });
  return { events: port.events, port, dispute, logs, time };
}

/** The evidence document that this kit writes for the job `ESCROW`: ME challenges OTHER on the claim REF_A with the facts of use case 1. `overrides` change members of the input. */
export function evidenceOf(overrides: Record<string, unknown> = {}) {
  const document = evidenceDocument({ ...PARTIES, ...ORDER_FACTS, ...overrides } as never);
  if (!document.ok) throw new Error(document.detail);
  return document.value;
}

/** A live challenge of ME against the claim REF_A, with the evidence of `evidenceOf()` at the URI of `EVIDENCE_TX`. `overrides` change members. */
export function challengeView(overrides: Partial<ChallengeView> = {}): ChallengeView {
  return {
    ref: `${CHALLENGE_TX}#0`, token: CHALLENGE_TOKEN, claim: REF_A, claim_token: TOKEN_A, auditor: ME, auditor_key_hash: KEY_HASH, stake_lovelace: 50_000_000n, evidence_hash: evidenceOf().hash,
    evidence_uri: documentUri(EVIDENCE_TX), challenged_at: NOW - 10 * 60_000, resolution_deadline_ms: 72 * HOUR, state: 'PendingOracle', ...overrides,
  };
}
