// packages/usecase-kit/test/dispute/statement.test.ts: the statement of a claim that a kind of evidence is about. Each kind is about one statement, and the evidence document and the choice of the target both
// use that statement. The question of these tests: can a challenge name a statement other than the one that its evidence is about? The three old kinds stay on S1, and their documents keep their bytes (the
// golden files are checked in documents.test.ts). The intake record is about S2 (its own documents and challenges are in evidence-intake.test.ts). Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { documentHash } from '@vsa/buyer-core';
import { NO_OPEN_CLAIM } from '@vsa/usecase-kit/protocol';
import { EVIDENCE_STATEMENTS, claimDocument, evidenceDocument, evidenceReferences } from '@vsa/usecase-kit/dispute';
import type { ApprovalChallengeInput, ChallengeResult, ClaimView, ClaimScope, DeliveryChallengeInput, EvidenceDocumentInput, EvidenceKind } from '@vsa/usecase-kit/dispute';
import {
  APPROVAL_JOB, CLAIM_CAPABILITY, DELIVERY_JOB, DIGEST_FACTS, ESCROW, HOUR, INTAKE_FACTS, INTAKE_PARTIES, MANIFEST_SHA, ME_ID, NOW, ORDER_DESK_CLAIM, ORDER_FACTS, OTHER, PARTIES, QUOTE_FACTS, REF_A, REF_B,
  REORDER_AGENT_CLAIM, SCOPE, STATEMENT_S1, TOKEN_B, claimView, escrowJob, kitClaimDocument, rig, senderClaimView,
} from './support.ts';
import type { ScriptedPort } from './support.ts';

const delivery = (extra: Partial<DeliveryChallengeInput> = {}): DeliveryChallengeInput => ({ counterparty: OTHER, escrow_ref: ESCROW, ...DELIVERY_JOB, evidence: ORDER_FACTS, ...extra });
const approval = (extra: Partial<ApprovalChallengeInput> = {}): ApprovalChallengeInput => ({ sender: OTHER, escrow_ref: ESCROW, ...APPROVAL_JOB, evidence: DIGEST_FACTS, ...extra });

const MARKER = 'zq9-marker-7f3';
const S1_TEXT = STATEMENT_S1;
const S2_TEXT = ORDER_DESK_CLAIM.statements[1].text;
const S3_TEXT = ORDER_DESK_CLAIM.statements[2].text;
const OTHER_TEXT = 'This agent answers each request that it takes.';

/** The claim document that this kit writes for OTHER for the capability of the job, with these three statements. */
function claimWith(first: string, second: string, third: string) {
  const document = claimDocument({
    agent_did: OTHER, capability_id: CLAIM_CAPABILITY, manifest_sha256: MANIFEST_SHA,
    claim: { statements: [{ id: 'S1', text: first }, { id: 'S2', text: second }, { id: 'S3', text: third }] },
  });
  if (!document.ok) throw new Error(document.detail);
  return document.value;
}

/** Gives a claim a document: the bytes go to the port at the URI of the claim, and the claim holds their hash. */
function holding(port: ScriptedPort, claim: ClaimView, bytes: Uint8Array): ClaimView {
  port.documents.set(claim.claim_uri, { bytes, type: 'claim', media_type: 'text/plain' });
  return { ...claim, claim_hash: documentHash(bytes) };
}

/** A claim of OTHER that was staked a minute after the claim of the samples and that ends later: a lookup reads its document first. */
const newer = (overrides: Partial<ClaimView> = {}): ClaimView => claimView({ ref: REF_B, token: TOKEN_B, submitted_at: NOW - HOUR + 60_000, challenge_window_ms: 20 * HOUR, ...overrides });

function expectNotFiled(result: ChallengeResult, code: string): asserts result is Extract<ChallengeResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}

/** The detail of no_open_claim for `open` open claims, the counts of the seven reasons in the order of the detail, and the id that the lookup is about. */
const counted = (open: number, left: readonly [number, number, number, number, number, number, number], id = 'S1'): string =>
  `the agent has ${open} open claim(s), and none can be challenged: ${left[0]} with a challenge window that ends too soon, ${left[1]} submitted at or after the start of the job, `
  + `${left[2]} with a stake above the challenge stake, ${left[3]} whose claim document is not on chain or is not a document, ${left[4]} without a claim document of this kit, `
  + `${left[5]} with a claim document for another capability, ${left[6]} with a claim document whose statement ${id} is another text`;

/** The scope of the job of the samples, for the statement `id` that has the text `text`. */
const scopeOf = (id: ClaimScope['statement_id'], text: string): ClaimScope => ({ ...SCOPE, statement_id: id, statement_text: text });

/** An input of each kind of evidence, with the statement text of the samples. The type has one entry for each kind, so a kind that this file does not check is a type error. */
const INPUTS: Record<EvidenceKind, EvidenceDocumentInput> = {
  order_confirmation: { ...PARTIES, ...ORDER_FACTS } as unknown as EvidenceDocumentInput,
  quote_price: { ...PARTIES, ...QUOTE_FACTS } as unknown as EvidenceDocumentInput,
  approval_digest: { ...PARTIES, ...DIGEST_FACTS } as unknown as EvidenceDocumentInput,
  intake_record: { ...INTAKE_PARTIES, ...INTAKE_FACTS } as unknown as EvidenceDocumentInput,
};
const KINDS = Object.keys(EVIDENCE_STATEMENTS) as EvidenceKind[];

const documentOf = (kind: EvidenceKind) => {
  const document = evidenceDocument(INPUTS[kind]);
  if (!document.ok) throw new Error(document.detail);
  return document.value;
};

describe('the statement of a kind of evidence', () => {
  it('names one statement for each kind: the three old kinds are about S1, and the intake record is about S2', () => {
    expect(EVIDENCE_STATEMENTS).toEqual({ order_confirmation: 'S1', quote_price: 'S1', approval_digest: 'S1', intake_record: 'S2' });
  });

  it('is a table that no caller can change', () => {
    expect(Object.isFrozen(EVIDENCE_STATEMENTS)).toBe(true);
    expect(() => { (EVIDENCE_STATEMENTS as Record<string, string>).approval_digest = 'S2'; }).toThrow(TypeError);
    expect(() => { (EVIDENCE_STATEMENTS as Record<string, string>).extra_kind = 'S1'; }).toThrow(TypeError);
    expect(EVIDENCE_STATEMENTS.approval_digest).toBe('S1');
  });

  it('has an input of each kind in this file, so that no kind goes unchecked', () => {
    expect(Object.keys(INPUTS).sort()).toEqual([...KINDS].sort());
  });

  it.each(KINDS)('writes the header and the statement row of the document of the kind %s with the id of its statement', (kind) => {
    const rows = documentOf(kind).text.split('\n');
    const id = EVIDENCE_STATEMENTS[kind];
    expect(rows[0]).toBe(`Evidence about statement ${id} of a claim on the Vector marketplace.`);
    expect(rows[1]).toBe(`Statement ${id} of the claim reads: "${INPUTS[kind].statement_text}"`);
  });

  it('writes the two rows of the three old kinds as they were: the statement S1, byte for byte', () => {
    for (const kind of ['order_confirmation', 'quote_price', 'approval_digest'] as const) {
      const rows = documentOf(kind).text.split('\n');
      expect(rows[0], kind).toBe('Evidence about statement S1 of a claim on the Vector marketplace.');
      expect(rows[1], kind).toBe('Statement S1 of the claim reads: "A confirmation that this agent signs names the SKU, the lot and the quantity of the purchase order that it answers."');
    }
  });

  it.each(KINDS)('refuses a member statement_id in the facts of the kind %s, so that the facts cannot name a statement either', (kind) => {
    for (const id of ['S1', 'S2', 'S3']) {
      const refused = evidenceDocument({ ...INPUTS[kind], statement_id: id } as unknown as EvidenceDocumentInput);
      expect(refused, `${kind} with ${id}`).toMatchObject({ ok: false, code: 'bad_shape' });
      expect(refused.ok ? '' : refused.detail).toContain('statement_id');
    }
  });
});

describe('the references of an evidence document are read back for the statement of each kind', () => {
  it.each(KINDS)('gives the references of the document of the kind %s', (kind) => {
    expect(evidenceReferences(documentOf(kind).bytes)).toMatchObject({ ok: true, value: { claim: REF_A, escrow_ref: ESCROW } });
  });

  it('refuses a header that names a statement that no kind is about, and a header that is not the header of the kit', () => {
    const header = 'Evidence about statement S1 of a claim on the Vector marketplace.';
    for (const other of [
      'Evidence about statement S3 of a claim on the Vector marketplace.', 'Evidence about statement S4 of a claim on the Vector marketplace.',
      'Evidence about statement s1 of a claim on the Vector marketplace.', 'Evidence about statement  of a claim on the Vector marketplace.',
    ]) {
      const changed = documentOf('order_confirmation').text.replace(header, other);
      expect(evidenceReferences(Buffer.from(changed, 'utf8')), other).toMatchObject({ ok: false, code: 'bad_shape' });
    }
  });
});

describe('a lookup names the statement that it is about', () => {
  it('takes the claim whose statement S2 is the text of the scope, and leaves out a claim whose S2 is another text although its S1 is the text of the job', async () => {
    const rigged = rig();
    const decoy = holding(rigged.port, newer(), claimWith(S1_TEXT, OTHER_TEXT, S3_TEXT).bytes);
    rigged.port.claims = [claimView(), decoy];
    expect(await rigged.dispute.findOpenClaim(OTHER, scopeOf('S2', S2_TEXT))).toMatchObject({ ok: true, value: { ref: REF_A } });
    // The decoy ends later, so its document is read first.
    expect(rigged.events.filter((event) => event.startsWith('readDocument'))).toEqual([`readDocument ${decoy.claim_uri}`, `readDocument ${claimView().claim_uri}`]);
    // The twin: the text of the S2 of the decoy takes the decoy.
    expect(await rigged.dispute.findOpenClaim(OTHER, scopeOf('S2', OTHER_TEXT))).toMatchObject({ ok: true, value: { ref: REF_B } });
  });

  it('takes the statement with the id and no other: S1, S2 and S3 of one document are three different statements', async () => {
    const rigged = rig();
    rigged.port.claims = [holding(rigged.port, claimView(), claimWith(S1_TEXT, S2_TEXT, S3_TEXT).bytes)];
    const cases: Array<[ClaimScope['statement_id'], string, boolean]> = [
      ['S1', S1_TEXT, true], ['S1', S2_TEXT, false], ['S1', S3_TEXT, false],
      ['S2', S2_TEXT, true], ['S2', S1_TEXT, false], ['S2', S3_TEXT, false],
      ['S3', S3_TEXT, true], ['S3', S1_TEXT, false], ['S3', S2_TEXT, false],
    ];
    for (const [id, text, found] of cases) {
      const result = await rigged.dispute.findOpenClaim(OTHER, scopeOf(id, text));
      if (found) expect(result, `${id} with its own text`).toMatchObject({ ok: true, value: { ref: REF_A } });
      else expect(result, `${id} with the text of another statement`).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
    }
  });

  it('uses S1 for a scope that names no statement, the same as a scope that names S1', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView()];
    const { statement_id: _none, ...unnamed } = scopeOf('S1', S1_TEXT);
    expect(await rigged.dispute.findOpenClaim(OTHER, unnamed)).toMatchObject({ ok: true, value: { ref: REF_A } });
    expect(await rigged.dispute.findOpenClaim(OTHER, scopeOf('S1', S1_TEXT))).toMatchObject({ ok: true, value: { ref: REF_A } });
    // The text of the S2 is not the S1 of this claim, with the id or without it.
    expect(await rigged.dispute.findOpenClaim(OTHER, { ...unnamed, statement_text: S2_TEXT })).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
    expect(await rigged.dispute.findOpenClaim(OTHER, scopeOf('S1', S2_TEXT))).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
  });

  /** A statement with accented letters: its NFC form and its NFD form are different texts of the same statement. */
  const ACCENTED = 'This agent places one order for each purchase order number, caf\u00e9 r\u00e8gle.';

  it('takes the same S2 text in NFD and in NFC as one statement, whichever form the claim document or the scope has', async () => {
    expect(ACCENTED.normalize('NFD')).not.toBe(ACCENTED.normalize('NFC'));
    const forms: Array<[string, string, string]> = [
      ['NFD in the claim document and NFC in the scope', ACCENTED.normalize('NFD'), ACCENTED.normalize('NFC')],
      ['NFC in the claim document and NFD in the scope', ACCENTED.normalize('NFC'), ACCENTED.normalize('NFD')],
      ['NFD in both', ACCENTED.normalize('NFD'), ACCENTED.normalize('NFD')],
      ['NFC in both', ACCENTED.normalize('NFC'), ACCENTED.normalize('NFC')],
    ];
    for (const [name, inDocument, inScope] of forms) {
      const rigged = rig();
      rigged.port.claims = [holding(rigged.port, claimView(), claimWith(S1_TEXT, inDocument, S3_TEXT).bytes)];
      expect(await rigged.dispute.findOpenClaim(OTHER, scopeOf('S2', inScope)), name).toMatchObject({ ok: true, value: { ref: REF_A } });
    }
    // A text that is more than another form of the same text is another statement.
    const rigged = rig();
    rigged.port.claims = [holding(rigged.port, claimView(), claimWith(S1_TEXT, ACCENTED.normalize('NFD').replace('e\u0301', 'e\u0300'), S3_TEXT).bytes)];
    expect(await rigged.dispute.findOpenClaim(OTHER, scopeOf('S2', ACCENTED.normalize('NFC')))).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
  });

  const NOT_TARGETS: Array<[string, (port: ScriptedPort) => ClaimView, readonly [number, number, number, number, number, number, number]]> = [
    ['an S2 that is another text, with the S1 of the job', (port) => holding(port, claimView(), claimWith(S1_TEXT, OTHER_TEXT, S3_TEXT).bytes), [0, 0, 0, 0, 0, 0, 1]],
    ['an S1 that is the text of the scope, and an S2 that is not', (port) => holding(port, claimView(), claimWith(S2_TEXT, OTHER_TEXT, S3_TEXT).bytes), [0, 0, 0, 0, 0, 0, 1]],
    [
      'no S2: a document with no row of the statement S2 is no claim document of this kit',
      (port) => holding(port, claimView(), Buffer.from(kitClaimDocument(OTHER).text.split('\n').filter((row) => !row.startsWith('S2: ')).join('\n'))),
      [0, 0, 0, 0, 1, 0, 0],
    ],
  ];

  it.each(NOT_TARGETS)('leaves out a claim with %s, names the statement S2 in the detail, and publishes nothing', async (_name, make, left) => {
    const rigged = rig();
    rigged.port.claims = [make(rigged.port)];
    const result = await rigged.dispute.findOpenClaim(OTHER, scopeOf('S2', S2_TEXT));
    expect(result).toMatchObject({ ok: false, code: NO_OPEN_CLAIM, detail: counted(1, left, 'S2') });
    expect(rigged.port.published).toEqual([]);
  });

  it('names the id of the lookup in the detail of no_open_claim, and writes the detail for S1 as it was', async () => {
    const SKIPPED = [0, 0, 0, 0, 0, 0, 1] as const;
    const S1_DETAIL = 'the agent has 1 open claim(s), and none can be challenged: 0 with a challenge window that ends too soon, 0 submitted at or after the start of the job, 0 with a stake above the challenge stake, '
      + '0 whose claim document is not on chain or is not a document, 0 without a claim document of this kit, 0 with a claim document for another capability, 1 with a claim document whose statement S1 is another text';
    const rigged = rig();
    rigged.port.claims = [claimView()];
    const unnamed = await rigged.dispute.findOpenClaim(OTHER, { ...SCOPE, statement_text: OTHER_TEXT });
    expect(unnamed).toMatchObject({ ok: false, code: NO_OPEN_CLAIM, detail: S1_DETAIL });
    for (const id of ['S1', 'S2', 'S3'] as const) {
      const result = await rigged.dispute.findOpenClaim(OTHER, scopeOf(id, OTHER_TEXT));
      expect(result, id).toMatchObject({ ok: false, code: NO_OPEN_CLAIM, detail: counted(1, SKIPPED, id) });
      expect(result.ok ? '' : result.detail, id).toContain(`whose statement ${id} is another text`);
    }
  });

  const BAD_IDS: Array<[string, unknown]> = [
    ['S4', 'S4'], ['S0', 'S0'], ['a lower-case id', 's1'], ['an id with a space', 'S1 '], ['an empty id', ''], ['a number', 1], ['null', null], ['a list', ['S1']], ['an object', { id: 'S1' }],
  ];

  it.each(BAD_IDS)('refuses %s as the statement of a scope before it reads the chain, and the detail names the member', async (_name, id) => {
    const rigged = rig();
    rigged.port.claims = [claimView()];
    const result = await rigged.dispute.findOpenClaim(OTHER, { ...scopeOf('S1', S1_TEXT), statement_id: id } as unknown as ClaimScope);
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(result.ok ? '' : result.detail).toContain('statement_id');
    expect(rigged.events).toEqual([]);
  });

  it('does not repeat the text of a statement id that it refuses, and accepts S1, S2 and S3 as the twin', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView()];
    const refused = await rigged.dispute.findOpenClaim(OTHER, { ...scopeOf('S1', S1_TEXT), statement_id: MARKER } as unknown as ClaimScope);
    expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(refused.ok ? '' : refused.detail).not.toContain(MARKER);
    expect(rigged.events).toEqual([]);
    for (const id of ['S1', 'S2', 'S3'] as const) {
      expect(await rigged.dispute.findOpenClaim(OTHER, scopeOf(id, S1_TEXT)), id).not.toMatchObject({ code: 'bad_shape' });
    }
  });
});

describe('a challenge takes the statement from the kind of its evidence', () => {
  const hiringMe = (port: ScriptedPort): void => {
    port.readEscrowAnswer = () => escrowJob({ agent_id: ME_ID });
  };

  it('refuses a member statement_id in a delivery and in an approval, whatever its value, before it reads the chain, and files the same challenge without it', async () => {
    for (const id of ['S1', 'S2', 'S3', 'S4', MARKER, 1, null]) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      const asDelivery = await rigged.dispute.challengeDelivery({ ...delivery(), statement_id: id } as unknown as DeliveryChallengeInput);
      expectNotFiled(asDelivery, 'bad_shape');
      expect(asDelivery.detail).toContain('statement_id');
      expect(asDelivery.detail).not.toContain(MARKER);
      const asApproval = await rigged.dispute.challengeApproval({ ...approval(), statement_id: id } as unknown as ApprovalChallengeInput);
      expectNotFiled(asApproval, 'bad_shape');
      expect(asApproval.detail).toContain('statement_id');
      expect(rigged.events, String(id)).toEqual([]);
      expect(rigged.port.published).toEqual([]);
    }
    const twin = rig();
    twin.port.claims = [claimView()];
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('has input types with no member statement_id: the kind of the evidence decides it', () => {
    // @ts-expect-error A delivery names no statement id: the kind of its evidence is about one statement.
    const inDelivery: DeliveryChallengeInput = { ...delivery(), statement_id: 'S2' };
    // @ts-expect-error An approval names no statement id either.
    const inApproval: ApprovalChallengeInput = { ...approval(), statement_id: 'S2' };
    expect([inDelivery, inApproval]).toHaveLength(2);
  });

  it('files a delivery of the kind order_confirmation against the claim whose S1 is the text of the job, and the evidence quotes that S1', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView()];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    const rows = Buffer.from(rigged.port.published[0]!.bytes).toString('utf8').split('\n');
    expect(rows[0]).toBe('Evidence about statement S1 of a claim on the Vector marketplace.');
    expect(rows[1]).toBe(`Statement S1 of the claim reads: "${S1_TEXT}"`);
  });

  it('leaves out a claim whose S2 is the text of the job when its S1 is another text: a delivery of the kind order_confirmation is about S1', async () => {
    const rigged = rig();
    rigged.port.claims = [holding(rigged.port, claimView(), claimWith(OTHER_TEXT, S2_TEXT, S3_TEXT).bytes)];
    const result = await rigged.dispute.challengeDelivery(delivery({ statement_text: S2_TEXT }));
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toBe(counted(1, [0, 0, 0, 0, 0, 0, 1], 'S1'));
    expect(rigged.port.published).toEqual([]);
    expect(rigged.port.challenged).toEqual([]);
  });

  it('leaves out a claim whose S2 is the text of the job when its S1 is another text: an approval is about S1', async () => {
    const rigged = rig();
    const sender = senderClaimView(rigged.port);
    rigged.port.claims = [sender];
    hiringMe(rigged.port);
    const text = REORDER_AGENT_CLAIM.statements[1].text;
    const result = await rigged.dispute.challengeApproval(approval({ statement_text: text }));
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toBe(counted(1, [0, 0, 0, 0, 0, 0, 1], 'S1'));
    expect(rigged.port.published).toEqual([]);
    // The twin: the text of the S1 of the sender is filed, and the evidence names S1.
    expect((await rigged.dispute.challengeApproval(approval())).ok).toBe(true);
    expect(Buffer.from(rigged.port.published[0]!.bytes).toString('utf8').split('\n')[0]).toBe('Evidence about statement S1 of a claim on the Vector marketplace.');
  });

  it('refuses a challenge for a kind that its method does not take, so the kind of a challenge cannot move to another method', async () => {
    const rigged = rig();
    expectNotFiled(await rigged.dispute.challengeApproval(approval({ evidence: ORDER_FACTS as unknown as ApprovalChallengeInput['evidence'] })), 'bad_shape');
    expectNotFiled(await rigged.dispute.challengeDelivery(delivery({ evidence: DIGEST_FACTS as unknown as DeliveryChallengeInput['evidence'] })), 'bad_shape');
    expect(rigged.events).toEqual([]);
  });
});
