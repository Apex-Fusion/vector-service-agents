// scripts/operator/tasks/attest.ts - the task attest: the Provider key issues a provenance attestation and a software attestation for each agent, and the documents that they name.
// Attestations come AFTER the deploy: the image digest in the document must be the digest of the running container and the digest of the public tag that CI made for the commit.
//
//   attest run --record --commit <sha>   Makes no transaction, needs no approval and no key. For each agent it checks that the running containers run the public images of the commit and that
//                                        the service serves the manifest that the facts hold, and it writes the document file. A docs pull request then publishes the files.
//   attest run --commit <sha> --locator-base <url>
//                                        Each `<agent>:<type>` step checks the document at the locator. Its digest must match the exact canonical bytes for that
//                                        agent's served manifest and running service image. If the data requires an envelope, the Provider signs its COSE Sig_structure.
//                                        The second build uses that signature and the same `issued_at`. Each `visible:<agent>:<type>` step then waits for the gateway.
//   attest cleanup                       Withdraws the deposit of each attestation whose `valid_until` plus 90 days has passed. For the others it prints the date.
//
// The Provider key signs two kinds of bytes: an attestation transaction (through `landBuilt`) and the Sig_structure of the envelope, which this file computes itself from the five fields that
// the envelope covers. The only call of `signMessage` of the pack is in this file.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { collateralAdvice, isCollateralOutput } from '../../checks/lib/collateral.ts';
import { duration, iso, units } from '../../checks/lib/format.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { StepOutcome } from '../../checks/lib/session.ts';
import type { StepRecord } from '../../checks/lib/state.ts';
import { verifyWithTools } from '../../checks/lib/verify.ts';
import type { HostedTools, ToolAnswer } from '../../checks/lib/hosted.ts';
import type { ToolCheck } from '../../checks/lib/verify.ts';
import { requireGo } from '../lib/approval.ts';
import { attestationDocumentName, attestationDocumentOf, documentMatches, readLimited, requirePublicDigests, runningImagesOf, writeAttestationDocument } from '../lib/build-record.ts';
import type { AttestationDocument, RunningImages } from '../lib/build-record.ts';
import type { AgentSpec, AttestationFact, AttestationSpec, DeployFact, RecordFact, TaskDefinition, TaskFlags, TaskSession, UseCase } from '../lib/contract.ts';
import { readRunningImages, requireRuntimesFree, runtimesOf } from '../lib/free.ts';
import { landBuilt } from '../lib/land-hosted.ts';
import { planOf } from '../lib/plan.ts';
import { ATT_TYPES, buildAttest, buildWithdrawAttestation, createGatewayClient, envelopeSigStructure, envelopeVerifies } from '../lib/platform.ts';
import type { AttestBuild } from '../lib/platform.ts';
import { FlagError, runSteps, waitFor } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';

type AttType = AttestationSpec['types'][number];

interface AttestSettings {
  /** The commit of the deployed build: the tag of the public images and the end of the name of each document file. */
  readonly commit: string | null;
  /** The raw folder of the published documents, at the commit of the docs pull request. */
  readonly locatorBase: string | null;
  readonly record: boolean;
}
type Session = TaskSession<AttestSettings>;

/** The deposit of an attestation: 5 units. The ledger returns it 90 days after `valid_until`. */
const DEPOSIT_LOVELACE = 5_000_000n;
/** The window of a build is 30 minutes: the attestation gets that end as its `issued_at`. */
const VALID_MINUTES = 30;
const DAY_MS = 86_400_000;
const WITHDRAW_WAIT_MS = 90 * DAY_MS;
/** A withdraw is built in a window that starts one minute before the build, and the ledger needs the whole window to be after the 90 days. */
const WITHDRAW_LEAD_MS = 60_000;
/** The gateway lists an attestation after 30 confirmations: about 2.5 minutes. It is failed when the list lacks it 15 minutes after the confirmation. */
const SHOWS_AFTER_MS = 150_000;
const SHOWS_LIMIT_MS = 15 * 60_000;
const SHOWS_RETRY_MS = 30_000;
const DOCUMENT_MAX_BYTES = 1_024;
const MANIFEST_MAX_BYTES = 262_144;
const LOCATOR_MAX_BYTES = 256;
const READ_TIMEOUT_MS = 15_000;
const RUNNING_IMAGES = 'running-images.json';
const DOCUMENTS = 'attestation-documents';
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
/** The folder of the published documents: raw files of this repository at ONE commit, so that the bytes at a locator never change. */
const LOCATOR_BASE = /^https:\/\/raw\.githubusercontent\.com\/Apex-Fusion\/vector-service-agents\/[0-9a-f]{40}\/docs\/attestations\/$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// ---- the flags ----

/** The flags of a run, checked as far as a run can be checked before it knows its command: `status` takes none, and a step needs `--commit` and `--locator-base` when it runs. */
function settingsOf(flags: TaskFlags): AttestSettings {
  const record = flags.has('record');
  if (record && flags.has('submit')) throw new FlagError('--record writes the documents and makes no transaction: it takes no --submit');
  const commit = flags.value('commit');
  if (commit !== undefined && !COMMIT.test(commit)) throw new FlagError('--commit is the commit of the deployed build: 40 lower-case hex characters');
  const base = flags.value('locator-base');
  if (base !== undefined && !LOCATOR_BASE.test(base)) {
    throw new FlagError('--locator-base is the raw folder of the published documents at a commit: https://raw.githubusercontent.com/Apex-Fusion/vector-service-agents/<40 hex characters>/docs/attestations/');
  }
  if (record && base !== undefined) throw new FlagError('--record writes the documents before they have a locator: it takes no --locator-base');
  return { commit: commit ?? null, locatorBase: base ?? null, record };
}

function commitOf(session: Session): string {
  const { commit } = session.extra;
  if (commit === null) throw new FlagError('this run needs --commit <the commit of the deployed build>');
  return commit;
}

// ---- reads ----

/** A GET that follows no redirect, takes status 200 only, and reads at most `max` bytes. `what` says what the request is for. */
async function read(session: Session, url: string, accept: string, max: number, what: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await session.fetchImpl(url, { method: 'GET', headers: { accept }, redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (err) {
    throw new PreconditionError(`${what} could not be read: the request failed (${err instanceof Error ? err.name : 'an error'})`);
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new PreconditionError(`${what} could not be read: the answer has the status ${response.status}`);
  }
  let bytes: Uint8Array | null;
  try { bytes = await readLimited(response, max); } catch { throw new PreconditionError(`${what} could not be read: the body failed`); }
  if (bytes === null) throw new PreconditionError(`${what} is longer than ${max} bytes`);
  return bytes;
}

// ---- what must be true before a document is made or an attestation names it ----

interface Subject {
  readonly agent: AgentSpec;
  readonly record: RecordFact;
  readonly manifestSha256: string;
}

/** The agent of an attestation and what the facts hold of it: its record (the subject of the attestation) and the manifest that its adverts name. */
function subjectOf(session: Session, spec: AttestationSpec): Subject {
  const agent = session.use.agents.find((candidate) => candidate.id === spec.agent);
  if (agent === undefined) throw new PreconditionError(`the data of the use case names no agent ${spec.agent}`);
  const facts = session.facts.read();
  const record = facts.records[agent.id];
  if (record === undefined) throw new PreconditionError(`the facts hold no record of ${agent.id}: run the task register first`);
  const manifest = facts.manifests[agent.id];
  if (manifest === undefined) throw new PreconditionError(`the facts hold no manifest of ${agent.id}: run the task advert first`);
  if (!HASH.test(record.id) || record.did !== `did:vector:${record.id}`) throw new PreconditionError(`the record of ${agent.id} in the facts has an identifier that is not the one of its DID`);
  if (!HASH.test(manifest.sha256)) throw new PreconditionError(`the manifest of ${agent.id} in the facts has a SHA-256 that is not 64 lower-case hex characters`);
  const adverts = Object.entries(facts.adverts[agent.id] ?? {});
  if (adverts.length === 0) throw new PreconditionError(`the facts hold no advert of ${agent.id} to bind to its manifest`);
  for (const [model, advert] of adverts) {
    const planned = agent.adverts.find((candidate) => candidate.model === model);
    if (planned === undefined || advert.detailHash !== manifest.sha256 || advert.detailUri !== `${planned.origin.replace(/\/+$/, '')}/agent.json`) {
      throw new PreconditionError(`the manifest fact of ${agent.id} does not agree with its recorded advert ${model}`);
    }
  }
  if (!adverts.some(([, advert]) => advert.detailUri === manifest.uri)) throw new PreconditionError(`the manifest fact of ${agent.id} names no URI of its recorded adverts`);
  return { agent, record, manifestSha256: manifest.sha256 };
}

interface Inspected {
  readonly subject: Subject;
  readonly images: RunningImages;
  /** The SHA-256 of the manifest that the service serves now: the facts hold the same value. */
  readonly manifestSha256: string;
  readonly document: AttestationDocument;
  readonly name: string;
}

/**
 * The checks that `--record` and each attestation step share. The containers of the agent run images of their repositories (`running-images.json`). Each running digest is the digest of the public
 * tag of the commit. The service serves the manifest that the facts hold, read now. The document is then the canonical JSON of that manifest hash and the digest of the running SERVICE image.
 */
async function inspect(session: Session, spec: AttestationSpec, commit: string, running: ReadonlyMap<string, string>): Promise<Inspected> {
  const subject = subjectOf(session, spec);
  const images = runningImagesOf(subject.agent, running);
  await requirePublicDigests(session.fetchImpl, commit, images);
  const url = `${subject.agent.endpoint}/agent.json`;
  const served = sha256Of(await read(session, url, 'application/json', MANIFEST_MAX_BYTES, `the manifest of ${subject.agent.id} at ${url}`));
  if (served !== subject.manifestSha256) {
    throw new PreconditionError(`the manifest at ${url} has the SHA-256 ${served} now, and the facts hold ${subject.manifestSha256}, the manifest that the adverts of ${subject.agent.id} name: the service changed after its adverts`);
  }
  session.out.out(`the running images of ${subject.agent.id} are the public images of the commit ${commit}: ${[images.service, ...images.runtimes].map((image) => `${image.container} ${image.digest}`).join(', ')}`);
  return { subject, images, manifestSha256: served, document: attestationDocumentOf({ manifestSha256: served, imageDigest: images.service.digest }), name: attestationDocumentName(subject.agent.id, commit) };
}

function runningOf(session: Session): ReadonlyMap<string, string> {
  return readRunningImages(join(session.settings.stateDir, RUNNING_IMAGES), session.clock.now());
}

// ---- --record ----

/** Writes the document file of each agent, after every check of every agent has passed: no file is written for a build that fails a check. */
async function recordDocuments(session: Session): Promise<StepOutcome> {
  session.out.out('record: this run makes no transaction and loads no key, and it writes the document files');
  const commit = commitOf(session);
  const running = runningOf(session);
  const checked: Inspected[] = [];
  for (const spec of session.use.attestations) checked.push(await inspect(session, spec, commit, running));
  const images: Record<string, string> = {};
  for (const one of checked) for (const image of [one.images.service, ...one.images.runtimes]) images[image.container] = image.reference;
  const deploy: DeployFact = { commit, images };
  const held = session.facts.read().deploy;
  // The deploy record names the build of the documents. A record of another build is replaced while no attestation names it, and it stays when one does.
  if (held !== null && !isDeepStrictEqual(held, deploy) && Object.keys(session.facts.read().attestations).length > 0) {
    throw new PreconditionError(`the facts hold the deploy record of the commit ${held.commit}, and an attestation names that build: the deploy record of another build is not written`);
  }
  const dir = join(session.settings.stateDir, DOCUMENTS);
  const documents: Record<string, { name: string; sha256: string }> = {};
  for (const one of checked) {
    const outcome = writeAttestationDocument(dir, one.name, one.document);
    documents[one.subject.agent.id] = { name: one.name, sha256: one.document.sha256 };
    session.out.out(`the document ${one.name} of ${one.subject.agent.id}: SHA-256 ${one.document.sha256}, ${outcome === 'written' ? 'written' : 'there already'} in ${join(dir, one.name)}`);
  }
  session.facts.put('deploy', [], deploy, { replace: true });
  session.state.setNote('documents', documents);
  session.out.out('copy the files into docs/attestations/ in a docs pull request, and use the raw folder at the merge commit as --locator-base');
  return { kind: 'done', message: `the documents of the commit ${commit} are written: ${Object.values(documents).map((document) => document.name).join(', ')}` };
}

// ---- an attestation ----

/** The part of a step that has a colon in its name: the record that `landBuilt` and the visible steps keep as a note. */
const partOf = (session: Session, step: string): StepRecord | undefined => session.state.note<StepRecord>(`part.${step}`);

/** The wallet `fee` must hold a pure output of 5 units or more as collateral (the script runs), and at least `needed` in all. */
async function requireFeeWallet(session: Session, needed: bigint): Promise<void> {
  const address = session.registry.addressOf('fee');
  const outputs = await session.chain.provider.getUtxos(address);
  if (!outputs.some(isCollateralOutput)) {
    throw new PreconditionError(
      `The fee wallet ${session.registry.hashOf('fee')} has no pure output of 5 units or more. This step runs a script, and the script needs one as collateral. The address of the wallet is ${address}. ${collateralAdvice(address)}.`,
    );
  }
  const total = outputs.reduce((sum, output) => sum + (output.assets.lovelace ?? 0n), 0n);
  if (total < needed) throw new PreconditionError(`The fee wallet ${session.registry.hashOf('fee')} holds ${units(total)}, and this step needs ${units(needed)}: the deposit and the limit of the fee.`);
}

interface AttestationInput {
  readonly subject: string;
  readonly digest: string;
  readonly locatorHex: string;
  readonly format: number;
  readonly validDays: number;
  readonly withEnvelope: boolean;
}

/** The build that goes through the landing, the end of the attestation, and the signature of the envelope (null when there is none). */
interface Built {
  readonly build: AttestBuild;
  readonly validUntil: number;
  readonly envelopeSig: string | null;
}

/**
 * Builds the attestation. Without an envelope that is one build. With an envelope, pass 1 builds, and the Provider key signs the Sig_structure that this function computes from the five fields
 * that the envelope covers (it checks that the build gave the same bytes). Pass 2 builds again with the SAME `issued_at` and the signature, and only pass 2 is landed. The `issued_at` is the end of
 * the window of pass 1: when it has passed before pass 2 is built, the run starts again from pass 1, once. A dry run signs nothing: it builds pass 1 only.
 */
async function buildAttestation(session: Session, type: AttType, input: AttestationInput): Promise<Built> {
  const feeAddress = session.registry.addressOf('fee');
  const issuer = session.registry.publicKeyOf('provider');
  for (let attempt = 0; ; attempt += 1) {
    const now = session.clock.now();
    // A whole second: the ledger takes a time in milliseconds, and the attestation holds it as given.
    const validUntil = Math.floor((now + input.validDays * DAY_MS) / 1000) * 1000;
    const common = {
      changeAddress: feeAddress, subject: input.subject, issuer, attType: ATT_TYPES[type], digest: input.digest, format: input.format, locator: input.locatorHex, validUntil, solicited: true,
      depositLovelace: DEPOSIT_LOVELACE,
    };
    const first = await buildAttest(await session.chain.context(feeAddress), { ...common, nowMs: now, validMinutes: VALID_MINUTES });
    if (!input.withEnvelope) return { build: first, validUntil, envelopeSig: null };
    const fields = { issuer, issuerId: null, subject: input.subject, issuedAt: first.issuedAt, format: input.format, digest: input.digest };
    const structure = envelopeSigStructure(fields);
    if (first.sigStructure !== structure) throw new PreconditionError('the build gives a Sig_structure that is not the one of the five fields of the envelope: nothing was signed');
    if (session.mode === 'dry') return { build: first, validUntil, envelopeSig: null };
    // Check the use case, task, run wallet and tag before the provider signs the envelope. `landBuilt` checks them again before it signs the transaction.
    requireGo(session.go, { useCase: session.use.name, task: session.task, runWallet: session.registry.addressOf('run'), nowMs: session.clock.now(), irreversible: ['attestation'] });
    const envelopeSig = session.registry.key('provider').signMessage(Buffer.from(structure, 'hex'));
    if (!envelopeVerifies(fields, envelopeSig)) throw new PreconditionError('the signature of the envelope does not verify with the public key of the provider: nothing was landed');
    const context = await session.chain.context(feeAddress);
    if (session.clock.now() >= first.issuedAt) {
      if (attempt > 0) throw new PreconditionError(`the window of the first build ended before the second build twice (issued_at ${iso(first.issuedAt)}): nothing was landed`);
      session.out.out(`the window of the first build ended at ${iso(first.issuedAt)}, before the second build: starting again from the first build, once`);
      continue;
    }
    const second = await buildAttest(context, { ...common, nowMs: session.clock.now(), issuedAt: first.issuedAt, envelopeSig });
    if (second.issuedAt !== first.issuedAt || second.attestation.envelopeSig !== envelopeSig) {
      throw new PreconditionError('the second build has another issued_at or another envelope signature than the first: nothing was landed');
    }
    return { build: second, validUntil, envelopeSig };
  }
}

/** The public fact of an attestation, from the record that its step keeps. A record that lacks a member is refused, and nothing is guessed. */
function factOf(record: Pick<StepRecord, 'tx_hash' | 'refs' | 'facts'>): AttestationFact {
  const { digest, locator, valid_until: validUntil, issued_at: issuedAt, envelope } = record.facts;
  const id = record.refs.attestation_id;
  if (typeof record.tx_hash !== 'string' || typeof id !== 'string' || typeof digest !== 'string' || typeof locator !== 'string' || typeof validUntil !== 'string' || typeof issuedAt !== 'string' || typeof envelope !== 'boolean') {
    throw new PreconditionError('the record of the step has no attestation: the state file is damaged');
  }
  return { id, tx: record.tx_hash, digest, locator, validUntil, issuedAt, envelope };
}

/** Puts the fact of an attestation into the facts file. The same fact again changes nothing, so a step that was recorded and has no fact yet gets it at the next start. */
function keepFact(session: Session, spec: AttestationSpec, type: AttType, record: StepRecord): AttestationFact {
  const fact = factOf(record);
  session.facts.put('attestations', [spec.agent, type], fact);
  return fact;
}

const stepName = (spec: AttestationSpec, type: AttType): string => `${spec.agent}:${type}`;
const visibleName = (spec: AttestationSpec, type: AttType): string => `visible:${spec.agent}:${type}`;

/** What the hosted tool must show for an attestation of a step. A member that differs is named. */
function shownProblems(answer: Record<string, unknown>, id: string, type: AttType, record: StepRecord): string[] {
  if (answer.found !== true) return [`the hosted tool does not find the attestation ${id}`];
  const lower = (value: unknown): unknown => (typeof value === 'string' ? value.toLowerCase() : value);
  const problems: string[] = [];
  if (answer.att_type_code !== ATT_TYPES[type]) problems.push(`its type is not ${type}`);
  if (lower(answer.subject) !== record.facts.subject) problems.push('its subject is not the record of the agent');
  if (lower(answer.digest) !== record.facts.digest) problems.push('its digest is not the SHA-256 of the document');
  if (lower(answer.locator_hex) !== record.facts.locator_hex) problems.push('its locator is not the URL of the document');
  if (lower(answer.issuer_key_hash) !== record.facts.issuer_key_hash) problems.push('its issuer key is not the key of the provider');
  if (answer.solicited !== true) problems.push('it is not solicited, and the gateway lists no other');
  const hasEnvelope = (answer.envelope_sig ?? null) !== null;
  if (hasEnvelope !== (record.facts.envelope === true)) problems.push(hasEnvelope ? 'it has an envelope signature' : 'it has no envelope signature');
  return problems;
}

/**
 * The answer of the hosted tool with the envelope signature replaced by its SHA-256. The evidence file keeps what a tool answered, and it holds the signature as a hash and never as bytes.
 * A check still sees that an envelope signature is there.
 */
function withEnvelopeHash(answer: ToolAnswer): ToolAnswer {
  const signature = answer.json?.envelope_sig;
  if (answer.json === null || typeof signature !== 'string') return answer;
  return { ...answer, json: { ...answer.json, envelope_sig: `sha256:${sha256Of(Buffer.from(signature, 'hex'))}` } };
}

function attestationStep(spec: AttestationSpec, type: AttType): StepHandler<AttestSettings> {
  const name = stepName(spec, type);
  return {
    name,
    async run(session) {
      const held = session.facts.read().attestations[spec.agent]?.[type];
      if (held !== undefined) {
        throw new PreconditionError(`the facts file holds the ${type} attestation ${held.id} of ${spec.agent} already: an attestation of a step is made once, and another run label or a state file that was moved away does not change that`);
      }
      const commit = commitOf(session);
      const { locatorBase } = session.extra;
      if (locatorBase === null) throw new FlagError('an attestation step needs --locator-base <the raw folder of the published documents>');
      if (!Number.isInteger(spec.validDays) || spec.validDays < 1 || spec.validDays > 365) throw new PreconditionError('the data of the use case gives a validity of 1 to 365 days');
      if (!Number.isInteger(spec.format) || spec.format < 0 || spec.format > 65_535) throw new PreconditionError('the data of the use case gives a format that is not a CoAP content format number');
      const running = runningOf(session);
      await requireRuntimesFree({ fetchImpl: session.fetchImpl, runtimes: session.use.agents.flatMap(runtimesOf), running: new Set(running.keys()), out: session.out });
      const checked = await inspect(session, spec, commit, running);
      const { agent, record } = checked.subject;
      const locator = `${locatorBase}${checked.name}`;
      if (Buffer.byteLength(locator, 'utf8') > LOCATOR_MAX_BYTES) throw new PreconditionError(`the locator is longer than ${LOCATOR_MAX_BYTES} bytes`);
      const fetched = await read(session, locator, 'application/json, text/plain', DOCUMENT_MAX_BYTES, `the document at ${locator}`);
      if (!documentMatches(fetched, checked.document)) {
        throw new PreconditionError(
          `the document at ${locator} is not the canonical JSON of the manifest that ${agent.endpoint}/agent.json serves now (SHA-256 ${checked.manifestSha256}) `
          + `and the digest of the running image of ${checked.images.service.container} (${checked.images.service.digest}): an attestation names exactly those bytes`,
        );
      }
      // The digest of the attestation is the SHA-256 of the bytes that were fetched, and those bytes are the document.
      const digest = sha256Of(fetched);
      await requireFeeWallet(session, DEPOSIT_LOVELACE + session.settings.maxFeeLovelace);
      const locatorHex = Buffer.from(locator, 'utf8').toString('hex');
      const withEnvelope = spec.envelope !== null && spec.envelope.type === type;
      const { build, validUntil, envelopeSig } = await buildAttestation(session, type, { subject: record.id, digest, locatorHex, format: spec.format, validDays: spec.validDays, withEnvelope });
      const deployment = session.chain.deployment;
      const unit = `${deployment.attestation.hash}${build.id}`;
      const issuer = session.registry.hashOf('provider');
      const landed = await landBuilt(session, {
        step: name,
        built: { unsignedCbor: build.txCbor, txHash: build.txHash, feeLovelace: BigInt(build.fee), validTo: build.validTo },
        expectSigners: ['provider', 'controller', 'fee'],
        plan: () => planOf(session, {
          outflow: { fee: DEPOSIT_LOVELACE + session.settings.maxFeeLovelace }, destinations: [deployment.attestation.address], mint: { [unit]: 1n },
          labels: { [deployment.attestation.address]: 'the attestation script' },
        }),
        refs: () => ({ attestation_id: build.id, attestation_output: `${build.txHash}#${build.outputIndex}` }),
        facts: () => ({
          agent: agent.id, att_type: type, subject: record.id, digest, locator, locator_hex: locatorHex, issuer_key_hash: issuer, valid_until: iso(validUntil), issued_at: iso(build.issuedAt),
          envelope: envelopeSig !== null,
          ...(envelopeSig === null ? {} : { envelope_sig_sha256: sha256Of(Buffer.from(envelopeSig, 'hex')) }),
        }),
        notes: [
          `the provider key ${issuer} issues a ${type} attestation about ${record.did}, and the controller of the record co-signs it (solicited)`,
          `the document ${checked.name} at ${locator} has the SHA-256 ${digest}: it names the manifest that the service serves and the image ${checked.images.service.digest}`,
          `it is valid until ${iso(validUntil)}; the deposit of ${units(DEPOSIT_LOVELACE)} stays locked until the issuer withdraws it, from ${iso(validUntil + WITHDRAW_WAIT_MS)}`,
          withEnvelope
            ? 'the attestation carries an envelope: in a run with --submit the provider key signs the COSE Sig_structure of this build, and the transaction that lands is built a second time with that signature and the same issued_at'
            : 'the attestation has no envelope',
        ],
        irreversible: 'attestation',
      });
      if (landed.kind === 'dry') return { kind: 'dry' };
      const part = partOf(session, name);
      if (part === undefined) throw new PreconditionError(`the step ${name} landed and its record is missing from the state file`);
      keepFact(session, spec, type, part);
      return { kind: 'done', message: `the ${type} attestation ${build.id} of ${agent.id} is confirmed in ${landed.txHash}` };
    },
    async verify(session, record) {
      const fact = keepFact(session, spec, type, record);
      const check: ToolCheck = { tool: 'vector_get_attestation', args: { attestation: fact.id }, problems: (answer) => shownProblems(answer, fact.id, type, record) };
      const hosted: HostedTools = { call: async (tool, args) => withEnvelopeHash(await session.hosted.call(tool, args)) };
      await verifyWithTools({ hosted, evidence: session.evidence, clock: session.clock }, name, [check], { attestation: fact.id, att_type: type, envelope: fact.envelope });
    },
  };
}

// ---- the wait until the gateway lists the attestation ----

/** What the gateway shows of an agent: the attestation is listed, or it is not and the text says why. A list that holds the identifier with another type or digest is wrong, and it throws. */
async function shownBy(session: Session, did: string, fact: AttestationFact, type: AttType): Promise<{ shown: true } | { shown: false; why: string }> {
  const gateway = createGatewayClient({ baseUrl: session.settings.urls.gateway, fetch: session.fetchImpl, now: () => session.clock.now() });
  const result = await gateway.resolve(did);
  if (!result.ok) return { shown: false, why: `the gateway could not be read (${result.rule})` };
  if (result.value.kind !== 'resolved') return { shown: false, why: `the gateway gives no DID document (${result.value.kind})` };
  const provenance = result.value.metadata.vectorProvenance;
  const list: unknown[] = isObject(provenance) && Array.isArray(provenance.attestations) ? provenance.attestations : [];
  const entry = list.find((item) => isObject(item) && item.id === fact.id);
  if (entry === undefined) return { shown: false, why: 'the DID document lists no attestation with this identifier' };
  if (!isObject(entry) || entry.type !== type || entry.digest !== fact.digest) {
    throw new Error(`the gateway lists the attestation ${fact.id} with another type or another digest than the step made: the list of ${did} is wrong, or the attestation is not the one of this run`);
  }
  return { shown: true };
}

function visibleStep(spec: AttestationSpec, type: AttType): StepHandler<AttestSettings> {
  const name = visibleName(spec, type);
  return {
    name,
    async run(session) {
      const source = stepName(spec, type);
      const part = partOf(session, source);
      if (part === undefined) throw new PreconditionError(`the step ${source} is not confirmed: the attestation must land before it can show`);
      const fact = session.facts.read().attestations[spec.agent]?.[type] ?? factOf(part);
      const did = session.facts.read().records[spec.agent]?.did;
      if (did === undefined) throw new PreconditionError(`the facts hold no record of ${spec.agent}`);
      const now = session.clock.now();
      const confirmedAt = Date.parse(part.confirmed_at);
      const shown = await shownBy(session, did, fact, type);
      const what = `the ${type} attestation ${fact.id} of ${spec.agent}`;
      if (!shown.shown) {
        const limit = confirmedAt + SHOWS_LIMIT_MS;
        if (now >= limit) throw new Error(`${what} does not show in vectorProvenance of the DID document ${did}, ${duration(SHOWS_LIMIT_MS)} after its confirmation: ${shown.why}`);
        return waitFor(
          Math.max(confirmedAt + SHOWS_AFTER_MS, now + SHOWS_RETRY_MS), now,
          `${what} does not show in vectorProvenance of the DID document yet (${shown.why}). The gateway shows it after 30 confirmations, about 2.5 min, and this step fails ${duration(limit - now)} from now`,
        );
      }
      if (session.mode === 'dry') {
        session.out.out(`${what} shows in vectorProvenance of the DID document ${did}: a run with --submit records the step`);
        return { kind: 'dry' };
      }
      const at = iso(now);
      keepFact(session, spec, type, part);
      session.state.setNote(`part.${name}`, { confirmed_at: at, tx_hash: null, refs: { attestation_id: fact.id }, facts: { did, att_type: type, digest: fact.digest }, verified_at: at });
      return { kind: 'done', message: `${what} shows in vectorProvenance of the DID document ${did}` };
    },
  };
}

// ---- the steps ----

function handlersOf(use: UseCase): StepHandler<AttestSettings>[] {
  const pairs = use.attestations.flatMap((spec) => spec.types.map((type) => ({ spec, type })));
  return [...pairs.map(({ spec, type }) => attestationStep(spec, type)), ...pairs.map(({ spec, type }) => visibleStep(spec, type))];
}

// ---- cleanup ----

/** The step that takes the deposit of one attestation back: the Provider key signs as the issuer, and the wallet `fee` pays the fee and gets the deposit. */
async function withdraw(session: Session, agent: string, type: string, fact: AttestationFact): Promise<{ landed: boolean; line: string }> {
  const step = `withdraw:${agent}:${type}`;
  const what = `the ${type} attestation of ${agent}`;
  const output = partOf(session, `${agent}:${type}`)?.refs.attestation_output;
  if (output === undefined) throw new PreconditionError(`the state file holds no output of ${what}: the withdraw cannot name the output that it spends`);
  await requireFeeWallet(session, 0n);
  const feeAddress = session.registry.addressOf('fee');
  const built = await buildWithdrawAttestation(await session.chain.context(feeAddress), { changeAddress: feeAddress, nowMs: session.clock.now(), id: fact.id });
  const unit = `${session.chain.deployment.attestation.hash}${fact.id}`;
  const landed = await landBuilt(session, {
    step,
    built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo },
    expectSigners: ['provider', 'fee'],
    plan: () => planOf(session, { outflow: { fee: session.settings.maxFeeLovelace }, explained: [output], mint: { [unit]: -1n } }),
    refs: () => ({ attestation_id: fact.id }),
    facts: () => ({ released_lovelace: String(built.releasedLovelace) }),
    notes: [`the provider key withdraws ${what} (${fact.id}): ${units(built.releasedLovelace)} return to the fee wallet, and the token is burned`],
  });
  if (landed.kind === 'dry') return { landed: false, line: `${what}: the withdraw is built and checked, and a run with --submit lands it` };
  return { landed: true, line: `the deposit of ${what}, ${units(built.releasedLovelace)}, is back in the fee wallet (${landed.txHash})` };
}

/** Withdraws each deposit that is due, and prints the date for each that is not. */
async function cleanup(session: Session): Promise<StepOutcome> {
  const counts = { withdrawn: 0, back: 0, waiting: 0 };
  let dry = false;
  for (const [agent, byType] of Object.entries(session.facts.read().attestations)) {
    for (const [type, fact] of Object.entries(byType)) {
      const what = `the ${type} attestation of ${agent}`;
      if (partOf(session, `withdraw:${agent}:${type}`) !== undefined) {
        session.out.out(`the deposit of ${what} is back already`);
        counts.back += 1;
        continue;
      }
      const dueAt = Date.parse(fact.validUntil) + WITHDRAW_WAIT_MS;
      if (!(session.clock.now() >= dueAt + WITHDRAW_LEAD_MS)) {
        session.out.out(`the deposit of ${what} is due on ${iso(dueAt)}, 90 days after its valid_until: it can be withdrawn one minute after that time`);
        counts.waiting += 1;
        continue;
      }
      const outcome = await withdraw(session, agent, type, fact);
      session.out.out(outcome.line);
      if (outcome.landed) counts.withdrawn += 1;
      else dry = true;
    }
  }
  if (dry) return { kind: 'dry' };
  if (counts.withdrawn + counts.back + counts.waiting === 0) return { kind: 'done', message: 'the facts hold no attestation: there is nothing to take back' };
  return { kind: 'done', message: `attestation deposits: ${counts.withdrawn} withdrawn, ${counts.back} back already, ${counts.waiting} not due yet` };
}

// ---- status and result ----

/** The lines of `status` that belong to this task: each attestation of the facts with the date from which its deposit can be withdrawn. */
async function status(session: Session): Promise<readonly string[]> {
  const lines: string[] = [];
  for (const [agent, byType] of Object.entries(session.facts.read().attestations)) {
    for (const [type, fact] of Object.entries(byType)) {
      lines.push(`the ${type} attestation of ${agent}: ${fact.id}, valid until ${fact.validUntil}${fact.envelope ? ', with an envelope' : ''}, the deposit can be withdrawn from ${iso(Date.parse(fact.validUntil) + WITHDRAW_WAIT_MS)}`);
    }
  }
  const deploy = session.facts.read().deploy;
  lines.push(deploy === null ? 'deploy: no document was written yet (run with --record)' : `deploy: the commit ${deploy.commit}, ${Object.keys(deploy.images).length} running containers`);
  return lines;
}

const attest: TaskDefinition<AttestSettings> = {
  name: 'attest',
  title: 'the Provider key issues a provenance attestation and a software attestation for each agent, and the documents that the attestations name',
  flags: ['record'],
  valued: ['commit', 'locator-base'],
  needs: { keys: (_use, flags) => (flags.has('record') ? [] : ['provider', 'controller', 'fee']), chain: true, hosted: ['vector_get_attestation'], approval: 'submit' },
  steps: (use) => handlersOf(use).map((handler) => handler.name),
  parse: (_env, _settings, _use, flags) => settingsOf(flags),
  next: (session) => (session.extra.record ? recordDocuments(session) : runSteps(session, handlersOf(session.use))),
  cleanup,
  status,
  result: (session) => {
    const facts = session.facts.read();
    return { commit: facts.deploy?.commit ?? null, documents: session.state.note('documents') ?? {}, attestations: facts.attestations };
  },
};

export default attest;
