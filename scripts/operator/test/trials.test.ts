import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadPriceList } from '../../../agents/bid-desk/src/checks/pricelist.ts';
import { priceListFileOf } from '../../../agents/bid-desk/src/serve/settings.ts';
import { createPrecheck } from '../../../agents/insurer-intake-agent/src/checks/precheck.ts';
import { takeJob } from '../../../agents/insurer-intake-agent/src/job/take.ts';
import { RecordingSink, ScriptedBook, makeWorld as makeIntakeWorld } from '../../../agents/insurer-intake-agent/test/checks/support.ts';
import { judgeQuote } from '../../../agents/sourcing-agent/src/quotes/decide.ts';
import { acceptDecision } from '../../../agents/sourcing-agent/test/quotes/support.ts';
import { documentHash } from '../../../packages/buyer-core/src/index.ts';
import { checkQuoteAnswersRfq, lineChecks, parseQuote, parseRfqDocument } from '../../../packages/usecase-kit/src/bids/index.ts';
import * as pricing from '../../../packages/usecase-kit/src/bids/pricelist.ts';
import {
  EVIDENCE_STATEMENTS, JUROR_RECORD_LIMIT_BYTES, MAX_JUROR_DOCUMENT_BYTES, evidenceReferences, jurorRecordSize, readClaimDocument,
} from '../../../packages/usecase-kit/src/dispute/index.ts';
import type { EvidenceKind } from '../../../packages/usecase-kit/src/dispute/index.ts';
import { parseIntakeRecord, parsePriorAuthRequest, parseRecordSet, recordSetSha256 } from '../../../packages/usecase-kit/src/priorauth/index.ts';
import { RECEIPT_CHECKS, canonicalJson, canonicalSha256, parseApprovalRef, parseDocument, proposalDigest } from '../../../packages/usecase-kit/src/protocol/index.ts';
import type { Did, ManifestClaim, ProtocolResult, ReceiptVerification } from '../../../packages/usecase-kit/src/protocol/index.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { UseCase } from '../lib/contract.ts';
import { FactsFile } from '../lib/facts.ts';
import { BID_DESK_CLAIM, INTAKE_CLAIM, PRIORAUTH_CLAIM, SOURCING_CLAIM } from '../lib/platform.ts';
import { runTask } from '../lib/runner.ts';
import { trialOf } from '../lib/trials/index.ts';
import { SAMPLE_ADVERT_REF, SAMPLE_ESCROW_REF } from '../lib/trials/shared.ts';
import claim from '../tasks/claim.ts';
import bids from '../usecases/bid-evaluation.ts';
import inventory from '../usecases/inventory-reorder.ts';
import priorAuth from '../usecases/prior-authorization.ts';
import { USE_CASE, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

// SHA-256 of each file that the inventory trial wrote with no facts before the split.
const INVENTORY_HASHES = {
  'wrong-lot.claim.txt': '30983a2bcc7a1e363b6442cd1b4a5312b01c1e630fcdaadf27db3627e3c684d9',
  'wrong-lot.evidence.txt': '0a95bae6131729ebbc75c0882e452f3bc204334444860cb617ca65506d1bde27',
  'wrong-lot.purchase-order.json': '18d46eaa0b70023cb93ce6dd213f6ab1fd2553461b0c18122e8ccc8ca52c8514',
  'wrong-lot.confirmation.json': '37991967ca6b3993bf42ec6d743ebef8b0c8e34494f140c1ab50990075e9b6c7',
  'wrong-quantity.claim.txt': '30983a2bcc7a1e363b6442cd1b4a5312b01c1e630fcdaadf27db3627e3c684d9',
  'wrong-quantity.evidence.txt': '4ed9f4a26e4c86fcb50ca4f6e6751a201249bdf5a7a8ad50683b15aa6a559992',
  'wrong-quantity.purchase-order.json': '18d46eaa0b70023cb93ce6dd213f6ab1fd2553461b0c18122e8ccc8ca52c8514',
  'wrong-quantity.confirmation.json': '0b40aaf2231ba7ae1d068bd8f263cd629a6cc4ae19fe60332b558adee8f539cf',
  'wrong-sku.claim.txt': '30983a2bcc7a1e363b6442cd1b4a5312b01c1e630fcdaadf27db3627e3c684d9',
  'wrong-sku.evidence.txt': 'ddda08127e1b655dcce473e99d4090ff837165f661b40337846955dfef56dc10',
  'wrong-sku.purchase-order.json': '18d46eaa0b70023cb93ce6dd213f6ab1fd2553461b0c18122e8ccc8ca52c8514',
  'wrong-sku.confirmation.json': '19de7a33891beaf240d5fed231680fecfeb1db8b833da3e9c339e14c34576ac0',
  'trial.json': '68b28c8bb583524023bb347f598cb94984a9d5ae4e2ce8f938a8116bd8cc171f',
};

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const trialDir = (world: TaskWorld): string => join(world.stateDir, 'trial');

function valueOf<T>(result: ProtocolResult<T, string>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
  return result.value;
}

// The test loader supplies data without adding these names to the public operator CLI.
async function trialWorld(use: UseCase): Promise<TaskWorld> {
  return taskWorld({ keys: [], shared: [], use: { name: use.name, agents: use.agents, runs: use.runs, organisations: use.organisations }, env: { OPERATOR_USE_CASE: USE_CASE } });
}

async function runTrial(world: TaskWorld): Promise<number> {
  const readRegistry = vi.fn(() => { throw new Error('the registry was opened'); });
  const code = await runTask(claim, ['run', '--trial'], world.deps({ readRegistry }));
  expect(readRegistry).not.toHaveBeenCalled();
  expect(world.node.networkReads).toBe(0);
  expect(world.node.reads).toStrictEqual([]);
  expect(existsSync(world.goPath)).toBe(false);
  return code;
}

interface CaseIndex {
  case: string; kind: EvidenceKind | null; claimer: string; challenger?: string;
  files: { file: string; bytes: number; sha256: string; document_hash?: string }[];
}
interface Index {
  format: 1; sample: Record<string, boolean>; agents: Record<string, { did: string; manifest_sha256: string }>; cases: CaseIndex[];
}

function readTrial(world: TaskWorld) {
  expect(world.machine()).toMatchObject({ exit: 0, outcome: 'done', result: { trial: true } });
  const dir = trialDir(world);
  const bytes = (file: string) => readFileSync(join(dir, file));
  const text = (file: string) => bytes(file).toString('utf8');
  const json = (file: string): unknown => JSON.parse(text(file));
  const index = json('trial.json') as Index;
  expect(index.format).toBe(1);
  const files = index.cases.flatMap((entry) => entry.files);
  expect(readdirSync(dir).sort()).toStrictEqual(['trial.json', ...files.map(({ file }) => file)].sort());
  for (const { file, bytes: size, sha256, document_hash: jurorHash } of files) {
    const body = bytes(file);
    const raw = body.toString('utf8');
    const published = file.endsWith('.price-list.json');
    if (!published) expect(raw.endsWith('\n'), file).toBe(true);
    expect(body.length, file).toBe(size);
    expect(digest(body), file).toBe(sha256);
    if (file.endsWith('.txt')) {
      expect(body.length, file).toBeLessThanOrEqual(MAX_JUROR_DOCUMENT_BYTES);
      expect(jurorRecordSize(raw), file).toBeLessThanOrEqual(JUROR_RECORD_LIMIT_BYTES);
      expect(jurorHash, file).toBe(documentHash(body));
    } else {
      expect(jurorHash, file).toBeUndefined();
      if (!published) expect(raw, file).toBe(`${valueOf(canonicalJson(JSON.parse(raw)))}\n`);
    }
  }
  expect(world.machine().result).toMatchObject({
    sample: index.sample, cases: index.cases.map((entry) => entry.case), sha256: Object.fromEntries(files.map(({ file, sha256 }) => [file, sha256])),
  });
  return { index, bytes, text, json };
}

function checkPair(trial: { index: Index; bytes(file: string): Buffer }, entry: CaseIndex, expected: ManifestClaim, capability: string) {
  const subject = trial.index.agents[entry.claimer]!;
  const read = valueOf(readClaimDocument(trial.bytes(`${entry.case}.claim.txt`)));
  expect(read).toStrictEqual({ agent_did: subject.did, manifest_sha256: subject.manifest_sha256, capability_id: capability, claim: expected });
  if (entry.kind === null) {
    expect(entry.files.map(({ file }) => file)).toStrictEqual([`${entry.case}.claim.txt`]);
    return;
  }
  const evidence = trial.bytes(`${entry.case}.evidence.txt`);
  const refs = valueOf(evidenceReferences(evidence));
  expect(refs.against_did).toBe(read.agent_did);
  expect(refs.by_did).toBe(trial.index.agents[entry.challenger!]!.did);
  expect(refs.by_did).not.toBe(refs.against_did);
  const id = EVIDENCE_STATEMENTS[entry.kind];
  const statement = expected.statements.find((row) => row.id === id)!;
  expect(evidence.toString('utf8').split('\n').slice(0, 2)).toStrictEqual([
    `Evidence about statement ${id} of a claim on the Vector marketplace.`, `Statement ${id} of the claim reads: ${JSON.stringify(statement.text)}`,
  ]);
}

describe('offline claim trials', () => {
  it('does not select an unknown use case or an inherited property', () => {
    for (const name of ['other-use-case', 'constructor', '__proto__']) expect(() => trialOf(name)).toThrow(PreconditionError);
  });

  it('writes every inventory trial file with its original bytes', async () => {
    const world = await trialWorld(inventory);
    expect(await runTrial(world), world.screen.errors.join('\n')).toBe(0);
    const dir = trialDir(world);
    expect(Object.fromEntries(readdirSync(dir).map((file) => [file, digest(readFileSync(join(dir, file)))]))).toStrictEqual(INVENTORY_HASHES);
  });

  it('refuses the changed authorization request and sends the approved request in the intake record trial', async () => {
    const world = await trialWorld(priorAuth);
    const facts = FactsFile.open(join(world.stateDir, 'facts.json'), { useCase: priorAuth.name, network: 'vector-mainnet' });
    const did = '9a'.repeat(32);
    const manifest = '9b'.repeat(32);
    facts.put('records', ['insurer-intake-agent'], {
      did: `did:vector:${did}`, id: did, tx: did, recordRef: `${did}#0`, depositLovelace: '10000000', registeredAt: '2026-10-20T12:00:00.000Z',
    });
    facts.put('manifests', ['prior-authorization-agent'], {
      uri: 'https://agent.example/agent.json', sha256: manifest, bytes: 1200, readAt: '2026-10-20T12:00:00.000Z',
    });
    expect(await runTrial(world), world.screen.errors.join('\n')).toBe(0);
    const trial = readTrial(world);
    expect(trial.index.sample).toStrictEqual({
      'prior-authorization-agent_did': true, 'prior-authorization-agent_manifest_sha256': false,
      'insurer-intake-agent_did': false, 'insurer-intake-agent_manifest_sha256': true, references: true, documents: true,
    });
    expect(trial.index.agents['prior-authorization-agent']!.manifest_sha256).toBe(manifest);
    expect(trial.index.agents['insurer-intake-agent']!.did).toBe(`did:vector:${did}`);
    const [approvalCase, intakeCase] = trial.index.cases;
    expect(trial.index.cases).toMatchObject([
      { case: 'approval-digest', kind: 'approval_digest', claimer: 'prior-authorization-agent', challenger: 'insurer-intake-agent' },
      { case: 'intake-record', kind: 'intake_record', claimer: 'insurer-intake-agent', challenger: 'prior-authorization-agent' },
    ]);
    checkPair(trial, approvalCase!, PRIORAUTH_CLAIM, 'health.priorauth.draft.v1');
    checkPair(trial, intakeCase!, INTAKE_CLAIM, 'health.priorauth.intake.v1');

    const records = valueOf(parseRecordSet(trial.json('approval-digest.record-set.json')));
    const approved = valueOf(parsePriorAuthRequest(trial.json('approval-digest.approved-request.json')));
    const sent = valueOf(parsePriorAuthRequest(trial.json('approval-digest.sent-request.json')));
    expect(sent.order_id).toBe('ORD-1001');
    expect(sent.record_set_sha256).toBe(recordSetSha256(records));
    expect(sent).toStrictEqual({ ...approved, justification: 'The chart records pain and foot numbness. The request is for imaging with contrast.' });
    expect(approved.justification).toBe('The chart records pain and foot numbness. The request is for imaging without contrast.');
    const input = trial.json('approval-digest.approval.json') as { approval: unknown; salt: string; expected_digest: string; observed_digest: string };
    const approval = valueOf(parseApprovalRef(input.approval));
    expect(input.expected_digest).toBe(valueOf(proposalDigest(input.salt, approved)));
    expect(input.observed_digest).toBe(valueOf(proposalDigest(input.salt, sent)));
    expect(input.observed_digest).not.toBe(input.expected_digest);
    const approvalEvidence = trial.text('approval-digest.evidence.txt');
    expect(approvalEvidence).toContain(`The approval holds the digest ${input.expected_digest}.`);
    expect(approvalEvidence).toContain(`The request that the claimer sent holds the digest ${input.observed_digest}.`);
    expect(approvalEvidence).toContain(`Approval attestation: ${approval.attestation}`);
    expect(approvalEvidence).not.toContain(input.salt);
    expect(approvalEvidence).not.toContain(sent.justification);

    expect(trial.bytes('intake-record.sent-request.json')).toStrictEqual(trial.bytes('approval-digest.approved-request.json'));
    const intakeRequest = valueOf(parsePriorAuthRequest(trial.json('intake-record.sent-request.json')));
    expect(valueOf(proposalDigest(input.salt, intakeRequest))).toBe(input.expected_digest);
    const intake = valueOf(parseIntakeRecord(trial.json('intake-record.record.json')));
    const sentHash = valueOf(canonicalSha256(intakeRequest));
    expect(intake.request_number).toBe(intakeRequest.request_number);
    expect(intake.request_sha256).toBe(valueOf(canonicalSha256(sent)));
    expect(intake.request_sha256).not.toBe(sentHash);
    expect(intake.approval).toMatchObject(approval);

    // Run the real hook and job intake with local ledger and gateway fixtures. The approval on the ledger is for the trial's document and salt.
    const sender = priorAuth.agents.find(({ kind }) => kind === 'prior-authorization-agent')!;
    const organisation = priorAuth.organisations.find(({ id }) => id === sender.organisation)!.domain;
    expect(intake.sender).toStrictEqual({ did: trial.index.agents[sender.id]!.did, organisation, organisation_verified: true });
    const document = valueOf(parseDocument(intakeRequest));
    const control = makeIntakeWorld({ organisation: { domain: organisation }, request: document, attestation: { digest: input.expected_digest } });
    const passed = new RecordingSink();
    const schedule = vi.fn();
    const hook = createPrecheck({
      ports: control.ports, self: intakeRequest.insurer_did, book: new ScriptedBook(), passed,
      dispute: { challengeApproval: async () => { throw new Error('the local hook fixture must not file a challenge'); } }, schedule, log: () => {},
    });
    const context = { ...control.context, advertRef: intakeRequest.advert_ref };
    const handoff = { ...control.handoff, document, salt: input.salt };
    expect(await hook(handoff, context)).toEqual({ go: true });
    expect(schedule).not.toHaveBeenCalled();
    expect(passed.puts).toHaveLength(1);
    const taken = takeJob({ takeChecks: (ref) => passed.puts.find(({ escrowRef }) => escrowRef === ref)?.entry ?? null, log: () => {} }, handoff, context);
    expect(taken).toMatchObject({ request_sha256: sentHash, checks: intake.checks });
    expect(await hook({ ...handoff, document: valueOf(parseDocument(sent)) }, context)).toMatchObject({ go: false, error: 'approval_digest_mismatch' });
    expect(passed.puts).toHaveLength(1);
    const intakeEvidence = trial.text('intake-record.evidence.txt');
    expect(intakeEvidence).toContain(`The SHA-256 of the request that the challenger sent is ${sentHash}.`);
    expect(intakeEvidence).toContain(`names the SHA-256 ${intake.request_sha256} for the request that it received.`);
    expect(intakeEvidence).toContain(`SHA-256 of the intake record: ${digest(trial.bytes('intake-record.record.json'))}`);
  });

  it.each(['alfa', 'bravo', 'charlie'] as const)('builds the named price contradictions from the selected desk %s', async (instance) => {
    const desk = bids.agents.find(({ id }) => id === `bid-desk-${instance}`)!;
    const organisation = bids.organisations.find(({ id }) => id === desk.organisation)!.domain;
    const listPath = priceListFileOf(instance);
    const published = loadPriceList(listPath);
    const publishedBytes = readFileSync(listPath);
    const world = await trialWorld({ ...bids, agents: [desk, ...bids.agents.filter((agent) => agent !== desk)] });
    expect(await runTrial(world), world.screen.errors.join('\n')).toBe(0);
    const trial = readTrial(world);
    const names = ['price-above-list', 'price-below-list', 'price-of-another-break'];
    expect(trial.index.cases.map((entry) => entry.case)).toStrictEqual([...names, 'sourcing-claim']);
    expect(trial.index.sample).toStrictEqual({
      'sourcing-agent_did': true, 'sourcing-agent_manifest_sha256': true,
      [`${desk.id}_did`]: true, [`${desk.id}_manifest_sha256`]: true, references: true, documents: true,
    });
    for (const [number, name] of names.entries()) {
      const entry = trial.index.cases[number]!;
      expect(entry).toMatchObject({ kind: 'quote_price', claimer: desk.id, challenger: 'sourcing-agent' });
      checkPair(trial, entry, BID_DESK_CLAIM, 'supplychain.rfq.quote.v1');
      const rfq = valueOf(parseRfqDocument(trial.json(`${name}.rfq.json`)));
      const result = valueOf(parseDocument(trial.json(`${name}.quote.json`)));
      const quote = valueOf(parseQuote(result));
      const quoteSha = digest(trial.bytes(`${name}.quote.json`));
      expect(trial.bytes(`${name}.price-list.json`)).toStrictEqual(publishedBytes);
      expect(quote.price_list_sha256).toBe(published.sha256);
      const bidder = { did: trial.index.agents[desk.id]!.did as Did, organisation };
      expect(quote).toMatchObject({ desk_did: bidder.did, organisation });
      expect(checkQuoteAnswersRfq(quote, rfq).ok).toBe(true);
      expect(rfq.items.map(({ sku }) => sku)).toStrictEqual(['GLV-NIT-M', 'SYR-10ML', 'MSK-N95']);
      const [first, ...rest] = lineChecks(quote, published.list);
      const listed = pricing.priceFor(published.list, 'GLV-NIT-M', 100)!.unit_price;
      const other = pricing.priceFor(published.list, 'GLV-NIT-M', 500)!.unit_price;
      expect(first).toMatchObject({ sku: 'GLV-NIT-M', quantity: 100, listed_unit_price: listed, quoted_unit_price: [listed + 1, listed - 1, other][number] });
      expect(first?.quoted_unit_price).not.toBe(listed);
      expect(rest.every((row) => row.listed_unit_price === row.quoted_unit_price)).toBe(true);
      // The production judge must reach the model after the identity, request and list hash checks.
      const choice = { accept: false, mismatch: ['GLV-NIT-M'] };
      const acceptQuote = vi.fn(async () => ({ ok: true as const, choice, decision: acceptDecision(choice.accept, choice.mismatch) }));
      const judge = judgeQuote({ acceptQuote, note: () => {} }, rfq, bidder, published);
      expect(await judge.decide({
        escrow_ref: SAMPLE_ESCROW_REF, advert_ref: SAMPLE_ADVERT_REF, result, text: trial.text(`${name}.quote.json`),
        receipt: { escrow_ref: SAMPLE_ESCROW_REF, supplier_pkh: '0b'.repeat(28), response_hash: quoteSha },
        receipt_signature: '0c'.repeat(64), verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as ReceiptVerification,
      })).toStrictEqual({ accept: false, reason: 'declined_by_model' });
      expect(acceptQuote).toHaveBeenCalledOnce();
      const evidence = trial.text(`${name}.evidence.txt`);
      expect(evidence).toContain(`quoted the unit price ${first!.quoted_unit_price} for the SKU "GLV-NIT-M" at the quantity 100.`);
      expect(evidence).toContain(`gives the unit price ${first!.listed_unit_price} for the SKU "GLV-NIT-M" at the quantity 100.`);
      expect(evidence).toContain(`SHA-256 of the published price list: ${published.sha256}`);
      expect(evidence).toContain(`SHA-256 of the quote: ${quoteSha}`);
    }
    const sourcing = trial.index.cases[3]!;
    expect(sourcing).toMatchObject({ kind: null, claimer: 'sourcing-agent' });
    checkPair(trial, sourcing, SOURCING_CLAIM, 'supplychain.rfq.evaluate.v1');
  });

  it('writes nothing when the last price case does not contradict the list', async () => {
    const world = await trialWorld(bids);
    const original = pricing.priceFor;
    const lookup = vi.spyOn(pricing, 'priceFor').mockImplementation((list, sku, quantity) => original(list, sku, quantity === 500 ? 100 : quantity));
    try {
      expect(await runTrial(world)).toBe(2);
      expect(world.screen.errors.join('\n')).toContain('the price evidence of the case price-of-another-break cannot be made (no_contradiction)');
      expect(existsSync(trialDir(world))).toBe(false);
    } finally {
      lookup.mockRestore();
    }
    expect(await runTrial(world), world.screen.errors.join('\n')).toBe(0);
    expect(existsSync(join(trialDir(world), 'trial.json'))).toBe(true);
  });
});
