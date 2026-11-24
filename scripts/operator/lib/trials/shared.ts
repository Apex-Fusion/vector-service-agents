import { PreconditionError } from '../../../checks/lib/session.ts';
import { EVIDENCE_STATEMENTS, MAX_JUROR_DOCUMENT_BYTES, claimDocument, evidenceDocument } from '../../../../packages/usecase-kit/src/dispute/index.ts';
import type { ClaimDocumentInput, EvidenceFacts, JurorDocument } from '../../../../packages/usecase-kit/src/dispute/index.ts';
import { RECEIPT_CHECKS, canonicalJson } from '../../../../packages/usecase-kit/src/protocol/index.ts';
import type { AgentKind, JsonValue, ProtocolResult } from '../../../../packages/usecase-kit/src/protocol/index.ts';
import { CLAIM_OF_KIND } from '../claim-constants.ts';
import type { Facts, OrganisationSpec, UseCase } from '../contract.ts';

export const SAMPLE_CLAIM_REF = `${'ca'.repeat(32)}#0`;
export const SAMPLE_CLAIM_TOKEN = `636c6d5f${'0a'.repeat(28)}`;
export const SAMPLE_ESCROW_REF = `${'e5'.repeat(32)}#1`;
export const SAMPLE_ADVERT_REF = `${'b2'.repeat(32)}#0`;
const SAMPLE_KEY_HASH = '0b'.repeat(28);

export interface TrialFile { readonly file: string; readonly text: string; readonly juror: JurorDocument | null }
export interface TrialCase {
  readonly name: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly files: readonly TrialFile[];
}
export interface Trial {
  readonly sample: Readonly<Record<string, boolean>>;
  readonly subjects: Readonly<Record<string, unknown>>;
  readonly cases: readonly TrialCase[];
}
export type TrialBuilder = (use: UseCase, facts: Readonly<Facts>) => Trial;

export function requireBuilt<T>(built: ProtocolResult<T, string>, what: string): T {
  if (!built.ok) throw new PreconditionError(`the ${what} cannot be made (${built.code}): ${built.detail}`);
  return built.value;
}

/** A refusal or a document above the limit stops the trial before it writes files. */
export function trialDocument(built: ProtocolResult<JurorDocument, string>, what: string): JurorDocument {
  const document = requireBuilt(built, what);
  if (document.bytes.length > MAX_JUROR_DOCUMENT_BYTES) throw new PreconditionError(`the ${what} has ${document.bytes.length} bytes, and a document for a juror has at most ${MAX_JUROR_DOCUMENT_BYTES}`);
  return document;
}

export function canonicalText(value: unknown): string {
  const written = canonicalJson(value);
  if (!written.ok) throw new PreconditionError('a sample document has no canonical form');
  return `${written.value}\n`;
}

export function jsonFile(file: string, value: unknown): TrialFile {
  return { file, text: canonicalText(value), juror: null };
}

export function sampleDecision(name: string, choice: JsonValue, reasoning: string) {
  return {
    name, choice, reasoning,
    inference: {
      path: 'marketplace', accepted: 'confirmed',
      sub_job: {
        capability_id: 'sample.chat.v1', advert_ref: SAMPLE_ADVERT_REF, escrow_ref: SAMPLE_ESCROW_REF, supplier_pkh: SAMPLE_KEY_HASH, receipt: {}, receipt_signature: 'sample-signature',
        verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])),
      },
    },
  };
}

interface TrialAgent {
  readonly id: string;
  readonly organisation: OrganisationSpec;
  readonly claim: ClaimDocumentInput;
  readonly didIsSample: boolean;
  readonly manifestIsSample: boolean;
}

/** Take the first agent of this kind in data order, and use its public facts when available. */
export function trialAgent(use: UseCase, facts: Readonly<Facts>, kind: AgentKind, sampleDidByte: string, sampleManifestByte: string): TrialAgent {
  const agent = use.agents.find((candidate) => candidate.kind === kind);
  if (agent === undefined) throw new PreconditionError(`the data names no agent of kind ${kind} for the trial`);
  const organisation = use.organisations.find(({ id }) => id === agent.organisation);
  if (organisation === undefined) throw new PreconditionError(`the data names no organisation ${agent.organisation} for the trial agent ${agent.id}`);
  const record = facts.records[agent.id];
  const manifest = facts.manifests[agent.id];
  return {
    id: agent.id, organisation, didIsSample: record === undefined, manifestIsSample: manifest === undefined,
    claim: {
      agent_did: record?.did ?? `did:vector:${sampleDidByte.repeat(32)}`,
      capability_id: agent.capability,
      manifest_sha256: manifest?.sha256 ?? sampleManifestByte.repeat(32),
      claim: CLAIM_OF_KIND[kind],
    },
  };
}

export function trialSubjects(...agents: readonly TrialAgent[]): Pick<Trial, 'sample' | 'subjects'> {
  const sample: Record<string, boolean> = {};
  const subjects: Record<string, { did: string; manifest_sha256: string }> = {};
  for (const agent of agents) {
    sample[`${agent.id}_did`] = agent.didIsSample;
    sample[`${agent.id}_manifest_sha256`] = agent.manifestIsSample;
    subjects[agent.id] = { did: agent.claim.agent_did, manifest_sha256: agent.claim.manifest_sha256 };
  }
  return { sample: { ...sample, references: true, documents: true }, subjects: { agents: subjects } };
}

export function claimFile(name: string, agent: TrialAgent): TrialFile {
  const juror = trialDocument(claimDocument(agent.claim), `claim document of the case ${name}`);
  return { file: `${name}.claim.txt`, text: juror.text, juror };
}

export function evidenceFile(name: string, against: TrialAgent, by: TrialAgent, facts: EvidenceFacts): TrialFile {
  const statement = against.claim.claim.statements.find(({ id }) => id === EVIDENCE_STATEMENTS[facts.kind]);
  if (statement === undefined) throw new PreconditionError(`the claim of ${against.id} does not have the statement for ${facts.kind}`);
  const juror = trialDocument(evidenceDocument({
    ...facts, claim: SAMPLE_CLAIM_REF, claim_token: SAMPLE_CLAIM_TOKEN, escrow_ref: SAMPLE_ESCROW_REF,
    against_did: against.claim.agent_did, by_did: by.claim.agent_did, statement_text: statement.text,
  }), `evidence document of the case ${name}`);
  return { file: `${name}.evidence.txt`, text: juror.text, juror };
}
