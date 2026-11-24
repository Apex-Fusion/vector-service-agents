import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
// The pack platform does not export the node read of an attestation or its effective state.
import { attestationState, readAttestation } from '../../../packages/buyer-core/src/index.ts';
import type { AttestationView } from '../../../packages/buyer-core/src/index.ts';
// The vector-read entry has no attestation datum codec. Read the bytes before allowing a signature.
import { decodeAttestationDatum, utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import type { AttestationDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import { isCollateralOutput } from '../../checks/lib/collateral.ts';
import { iso } from '../../checks/lib/format.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import { eventually } from '../../checks/lib/retry.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { StepRecord } from '../../checks/lib/state.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { VERIFY_WINDOW, VerificationError } from '../../checks/lib/verify.ts';
import { complianceDocumentOf, readComplianceDocument, replyDocumentOf, writeComplianceDocument } from '../lib/compliance-document.ts';
import type { ComplianceFact, ComplianceSpec, RecordFact, StepOutcome, TaskDefinition, TaskFlags, TaskSession, UseCase } from '../lib/contract.ts';
import { landBuilt, landHosted } from '../lib/land-hosted.ts';
import { planOf } from '../lib/plan.ts';
import { ATT_TYPES, buildAttest, buildWithdrawAttestation, decodeTransaction, effectiveStatus, findRecord, keyHashOf } from '../lib/platform.ts';
import type { RecordUtxo, Utxo } from '../lib/platform.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';

const READ_TOOL = 'vector_get_attestation';
const REVOKE_TOOL = 'vector_build_attestation_revoke';
const CONTEST_TOOL = 'vector_build_attestation_contest';
const DEPOSIT = 5_000_000n;
const DAY_MS = 86_400_000;
const ISSUE_WINDOW_MS = 30 * 60_000;
// The withdrawal builder starts its validity window a minute before the build.
const WITHDRAW_LEAD_MS = 60_000;
const URI_BYTES = 256;
const HEX_32 = /^[0-9a-f]{64}$/;
const KEY_HASH = /^[0-9a-f]{56}$/;
const LOCATOR_BASE = /^https:\/\/raw\.githubusercontent\.com\/Apex-Fusion\/vector-service-agents\/[0-9a-f]{40}\/docs\/attestations\/$/;

type Spend = { kind: 'revoke'; agent: string; reason: number } | { kind: 'contest'; agent: string; replyUri: string };
type Extra = { kind: 'record' } | { kind: 'attest'; locatorBase: string | undefined } | Spend;
type Session = TaskSession<Extra>;

function validUri(uri: string): boolean {
  if (Buffer.byteLength(uri) > URI_BYTES || /[\s\\?#\p{Cc}]/u.test(uri)) return false;
  try {
    const url = new URL(uri);
    return url.href === uri && url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch { return false; }
}

function extraOf(use: UseCase, flags: TaskFlags): Extra {
  const record = flags.has('record');
  const revoke = flags.has('revoke');
  const contest = flags.has('contest');
  const agent = flags.value('agent');
  const reason = flags.value('reason');
  const replyUri = flags.value('reply-uri');
  const locatorBase = flags.value('locator-base');
  if (Number(record) + Number(revoke) + Number(contest) > 1) throw new FlagError('use only one of --record, --revoke and --contest');
  if (record && flags.has('submit')) throw new FlagError('--record takes no --submit');
  if (!revoke && reason !== undefined) throw new FlagError('--reason goes with --revoke only');
  if (!contest && replyUri !== undefined) throw new FlagError('--reply-uri goes with --contest only');
  if (locatorBase !== undefined && (record || revoke || contest || !LOCATOR_BASE.test(locatorBase))) {
    throw new FlagError('--locator-base is for issue only: give the raw docs/attestations/ folder of this repository at a commit');
  }
  if (!revoke && !contest && agent !== undefined) throw new FlagError('--agent goes with --revoke or --contest only');
  if (revoke || contest) {
    if (agent === undefined || !use.compliance?.subjects.includes(agent)) throw new FlagError('give --agent with the id of a compliance subject of this use case');
    if (revoke) {
      const code = reason === undefined ? 9 : Number(reason);
      if ((reason !== undefined && !/^[0-9]+$/.test(reason)) || !Number.isSafeInteger(code)) throw new FlagError('--reason must be a non-negative safe integer');
      return { kind: 'revoke', agent, reason: code };
    }
    if (replyUri === undefined || !validUri(replyUri)) throw new FlagError('--reply-uri must be an https URL with no credentials, query or fragment and at most 256 bytes');
    return { kind: 'contest', agent, replyUri };
  }
  return record ? { kind: 'record' } : { kind: 'attest', locatorBase };
}

function checkSpec(use: UseCase): void {
  const spec = use.compliance;
  if (spec === null) return;
  if (['provider', 'controller', 'fee', 'run'].includes(spec.issuerKey) || !use.keys.some(({ name, scope }) => name === spec.issuerKey && scope === 'use-case')) {
    throw new PreconditionError('the compliance issuer must have its own use-case key');
  }
  if (new Set(spec.subjects).size !== spec.subjects.length || spec.subjects.some((id) => !use.agents.some((agent) => agent.id === id))) {
    throw new PreconditionError('the compliance subjects must be distinct agents of the use case');
  }
  if (!Number.isInteger(spec.validDays) || spec.validDays < 1 || spec.validDays > 366) throw new PreconditionError('the compliance validity must be 1 to 366 days');
  if (!Number.isInteger(spec.format) || spec.format < 0 || spec.format > 65_535) throw new PreconditionError('the compliance format must be a CoAP Content-Format number');
}

function subjectOf(session: Session, agent: string): RecordFact {
  const record = session.facts.read().records[agent];
  if (record === undefined || !HEX_32.test(record.id) || record.did !== `did:vector:${record.id}`) {
    throw new PreconditionError(`the facts hold no valid record of ${agent}: register it first`);
  }
  return record;
}

async function subjectOnNode(session: Session, agent: string, subject: RecordFact): Promise<RecordUtxo> {
  const found = await findRecord(session.chain.provider, session.chain.deployment, subject.id);
  if (found === null || found.record.lineage.type !== 'Root') throw new PreconditionError(`the node does not show the root record of ${agent}`);
  return found;
}

function requireNetwork(session: Session): void {
  if (session.networkResult()?.ok !== true) throw new PreconditionError('the node is not shown to be on the network of the run');
}

function recordDocuments(session: Session, spec: ComplianceSpec): StepOutcome {
  const dir = join(session.settings.stateDir, 'documents');
  const documents = spec.subjects.flatMap((agent) => {
    const { did } = subjectOf(session, agent);
    return [complianceDocumentOf({ agent, did, statement: spec.statement }), replyDocumentOf({ agent, did, text: spec.reply.text })];
  });
  for (const document of documents) {
    const wrote = writeComplianceDocument(dir, document.name, document);
    session.out.out(`${document.name}: SHA-256 ${document.sha256}, ${wrote}`);
  }
  session.state.setNote('documents', documents.map(({ name, sha256 }) => ({ name, sha256 })));
  return { kind: 'done', message: `publish the ${documents.length} compliance documents from ${dir} at a commit before using their URLs` };
}

const refOf = (utxo: Utxo): string => `${utxo.txHash}#${utxo.outputIndex}`;
interface FeeWallet { address: string; collateral: ReadonlySet<string> }

async function feeWallet(session: Session, deposit = 0n): Promise<FeeWallet> {
  const address = session.registry.addressOf('fee');
  const outputs = await session.chain.provider.getUtxos(address);
  const collateral = outputs.filter(isCollateralOutput);
  if (collateral.length === 0) throw new PreconditionError('the fee wallet has no pure output of at least 5 units for collateral');
  const total = outputs.reduce((sum, output) => sum + (output.assets.lovelace ?? 0n), 0n);
  const needed = deposit + session.settings.maxFeeLovelace;
  if (!collateral.some((output) => total - output.assets.lovelace >= needed)) {
    throw new PreconditionError('the fee wallet does not cover the deposit and fee limit apart from its collateral');
  }
  return { address, collateral: new Set(collateral.map(refOf)) };
}

function bodyRefusal(step: string, message: string): GuardRefusal {
  return new GuardRefusal(step, [{ guard: 'body', ok: false, message }]);
}

/** The script step pays change and collateral return only to the fee wallet. The other signer provides no collateral. */
function requireFeeOutputs(step: string, facts: TxFacts, fee: FeeWallet, keptAddress?: string): void {
  if (!facts.runsScripts || facts.collateralInputs.length === 0 || facts.collateralInputs.some((ref) => !fee.collateral.has(ref))) {
    throw bodyRefusal(step, 'the script must use collateral from the fee wallet');
  }
  if (facts.outputs.some(({ address }) => address !== fee.address && address !== keptAddress) || (facts.collateralReturn !== null && facts.collateralReturn.address !== fee.address)) {
    throw bodyRefusal(step, 'every output except the attestation must go to the fee wallet');
  }
}

function outputOf(step: string, facts: TxFacts, address: string, unit: string, minimum: bigint) {
  const outputs = facts.outputs.filter((output) => output.address === address);
  const out = outputs[0];
  if (outputs.length !== 1 || out.assets[unit] !== 1n || Object.keys(out.assets).length !== 1 || out.inlineDatum === null || out.hasScriptRef || out.lovelace < minimum) {
    throw bodyRefusal(step, 'the transaction must keep exactly one attestation output with its token, inline datum and deposit');
  }
  try { return { index: out.index, lovelace: out.lovelace, datum: decodeAttestationDatum(out.inlineDatum) }; } catch {
    throw bodyRefusal(step, 'the attestation output has no readable inline datum');
  }
}

function heldFact(session: Session, agent: string): ComplianceFact {
  const fact = session.facts.read().compliance[agent];
  if (fact === undefined) throw new PreconditionError(`the facts hold no compliance attestation of ${agent}`);
  if (!HEX_32.test(fact.id) || !HEX_32.test(fact.tx) || !HEX_32.test(fact.digest) || !validUri(fact.locator)) {
    throw new PreconditionError(`the compliance fact of ${agent} is not valid`);
  }
  return fact;
}

function matchesIssue(view: AttestationView, fact: ComplianceFact, subject: string, spec: ComplianceSpec, issuerHash: string | null): boolean {
  const { attestation: a } = view;
  return view.id === fact.id && a.subject === subject && (issuerHash === null || keyHashOf(a.issuer) === issuerHash)
    && a.issuerId === null && a.attType === ATT_TYPES.identity && a.format === spec.format && a.profile === null && !a.solicited && a.envelopeSig === null
    && a.digest === fact.digest && a.locator === utf8Hex(fact.locator) && a.validFrom === null && a.links.length === 0
    && iso(a.issuedAt) === fact.issuedAt && a.validUntil === a.issuedAt + spec.validDays * DAY_MS && iso(a.validUntil) === fact.validUntil;
}

function issueFact(record: StepRecord): ComplianceFact {
  const id = record.refs.attestation_id;
  const tx = record.tx_hash;
  const { digest, locator, valid_until: validUntil, issued_at: issuedAt } = record.facts;
  if (!HEX_32.test(id) || tx === null || !HEX_32.test(tx) || typeof digest !== 'string' || !HEX_32.test(digest)
    || typeof locator !== 'string' || !validUri(locator) || typeof validUntil !== 'string' || typeof issuedAt !== 'string') {
    throw new PreconditionError('the state does not hold a valid compliance issue');
  }
  return { id, tx, digest, locator, validUntil, issuedAt, revokeTx: null, contestTx: null, replySha256: null, replyUri: null };
}

function keepIssue(session: Session, agent: string, fact: ComplianceFact): void {
  const earlier = session.facts.read().compliance[agent];
  if (earlier === undefined) session.facts.put('compliance', [agent], fact);
  else if (earlier.id !== fact.id || earlier.tx !== fact.tx || earlier.digest !== fact.digest || earlier.locator !== fact.locator || earlier.issuedAt !== fact.issuedAt || earlier.validUntil !== fact.validUntil) {
    throw new PreconditionError(`the compliance fact of ${agent} differs from the recorded issue`);
  }
}

function issueStep(spec: ComplianceSpec, agent: string): StepHandler<Extra> {
  const name = `attest:${agent}`;
  return {
    name,
    async run(session) {
      if (session.extra.kind !== 'attest' || session.extra.locatorBase === undefined) throw new FlagError('issue needs --locator-base <the raw folder of the published documents>');
      if (session.facts.read().compliance[agent] !== undefined) throw new PreconditionError(`the facts already hold a compliance attestation of ${agent}`);
      requireNetwork(session);
      const subject = subjectOf(session, agent);
      const onChain = await subjectOnNode(session, agent, subject);
      const observedAt = session.clock.now();
      if (effectiveStatus(onChain.record, new Map(), observedAt, observedAt) !== 'Active') throw new PreconditionError(`the record of ${agent} is not Active`);
      const document = complianceDocumentOf({ agent, did: subject.did, statement: spec.statement });
      const locator = `${session.extra.locatorBase}${document.name}`;
      if (Buffer.byteLength(locator) > URI_BYTES) throw new PreconditionError('the compliance locator exceeds 256 bytes');
      const digest = await readComplianceDocument(session.fetchImpl, locator, document);
      const fee = await feeWallet(session, DEPOSIT);
      const context = await session.chain.context(fee.address);
      const now = session.clock.now();
      const issuedAt = Math.floor(now / 1_000) * 1_000 + ISSUE_WINDOW_MS;
      const validUntil = issuedAt + spec.validDays * DAY_MS;
      const issuer = session.registry.publicKeyOf(spec.issuerKey);
      const issuerHash = session.registry.hashOf(spec.issuerKey);
      const locatorHex = utf8Hex(locator);
      const built = await buildAttest(context, {
        changeAddress: fee.address, subject: subject.id, issuer, attType: ATT_TYPES.identity, format: spec.format, digest, locator: locatorHex,
        validUntil, solicited: false, depositLovelace: DEPOSIT, nowMs: now, issuedAt,
      });
      const { address, hash } = session.chain.deployment.attestation;
      const unit = `${hash}${built.id}`;
      const expected: AttestationDatum = {
        subject: subject.id, issuer, issuerId: null, attType: ATT_TYPES.identity, format: spec.format, profile: null, digest, locator: locatorHex, envelopeSig: null,
        issuedAt, validFrom: null, validUntil, solicited: false, status: { type: 'AttActive' }, contested: null, links: [],
      };
      const landed = await landBuilt(session, {
        step: name, built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo },
        expectSigners: [spec.issuerKey, 'fee'], irreversible: 'attestation',
        plan: (facts) => {
          requireFeeOutputs(name, facts, fee, address);
          const output = outputOf(name, facts, address, unit, DEPOSIT);
          if (!facts.referenceInputs.includes(refOf(onChain.utxo)) || output.index !== built.outputIndex || output.lovelace !== DEPOSIT || !isDeepStrictEqual(output.datum, expected)) {
            throw bodyRefusal(name, 'the issue output does not match the subject, issuer, document, dates and deposit of this step');
          }
          return planOf(session, { destinations: [address], mint: { [unit]: 1n }, outflow: { fee: DEPOSIT + session.settings.maxFeeLovelace } });
        },
        refs: () => ({ attestation_id: built.id, attestation_output: `${built.txHash}#${built.outputIndex}` }),
        facts: () => ({ agent, subject: subject.id, issuer_key_hash: issuerHash, digest, locator, issued_at: iso(issuedAt), valid_until: iso(validUntil) }),
      });
      if (landed.kind === 'dry') return { kind: 'dry' };
      const part = session.state.note<StepRecord>(`part.${name}`);
      if (part === undefined) throw new PreconditionError('the state does not hold the confirmed compliance issue');
      keepIssue(session, agent, issueFact(part));
      return { kind: 'done', message: `the compliance attestation of ${agent} is confirmed in ${landed.txHash}` };
    },
    async verify(session, record) {
      requireNetwork(session);
      const fact = issueFact(record);
      keepIssue(session, agent, fact);
      const subject = subjectOf(session, agent).id;
      const issuerHash = session.registry.hashOf(spec.issuerKey);
      const output = record.refs.attestation_output;
      const args = { attestation: fact.id };
      const expected = {
        found: true, attestation: fact.id, output_ref: output, subject, issuer_key_hash: issuerHash, issuer_id: null, att_type_code: ATT_TYPES.identity,
        format: spec.format, digest: fact.digest, locator_hex: utf8Hex(fact.locator), issued_at: Date.parse(fact.issuedAt), valid_until: Date.parse(fact.validUntil),
        solicited: false, envelope_sig: null, status: 'active',
      };
      const checked = await eventually(session.clock, VERIFY_WINDOW, async () => {
        const view = await readAttestation(session.chain, fact.id);
        const nodeOk = view !== null && view.ref === output && view.utxo.txHash === fact.tx && view.lovelace === DEPOSIT && view.attestation.status.type === 'AttActive'
          && matchesIssue(view, fact, subject, spec, issuerHash);
        const hosted = await session.hosted.call(READ_TOOL, args);
        const hostedOk = !hosted.failed && hosted.json !== null && Object.entries(expected).every(([key, value]) => hosted.json?.[key] === value);
        return { done: nodeOk && hostedOk, value: nodeOk ? 'the hosted tool' : 'the node' };
      });
      if (!checked.done) throw new VerificationError(`${checked.value} does not show the compliance issue of ${agent} as built`);
      session.evidence.add({ step: name, status: 'verified', hosted: [{ tool: READ_TOOL, arguments: args, ok: true, result: expected }], shows: { agent, attestation_id: fact.id, attestation_output: output } });
    },
  };
}

/** Compute the start from the body. The landing checks the end against the clock of the node before it calls the plan. */
function revokeTime(step: string, cbor: string, facts: TxFacts, validTo: number): number {
  const start = decodeTransaction(cbor).body().validity_interval_start();
  const end = facts.validityEndSlot;
  if (start === undefined || end === null || end <= start || end - start > 3_600n || validTo % 1_000 !== 0) {
    throw bodyRefusal(step, 'the revoke needs a bounded validity window with whole seconds');
  }
  return validTo - Number(end - start) * 1_000;
}

async function requiredView(session: Session, agent: string, fact: ComplianceFact, subject: string, spec: ComplianceSpec): Promise<AttestationView> {
  const view = await readAttestation(session.chain, fact.id);
  if (view === null) throw new PreconditionError(`the node does not show the compliance attestation of ${agent}`);
  // Contest needs only the controller. Its scope is the attestation in the facts and the subject of that attestation.
  const issuer = session.registry.has(spec.issuerKey) ? session.registry.hashOf(spec.issuerKey) : null;
  if (!matchesIssue(view, fact, subject, spec, issuer)) throw new PreconditionError(`the attestation of ${agent} on the node does not match its issue`);
  return view;
}

function spendStep(spec: ComplianceSpec, spend: Spend): StepHandler<Extra> {
  const { agent, kind } = spend;
  const name = `${kind}:${agent}`;
  return {
    name,
    async run(session) {
      requireNetwork(session);
      const fact = heldFact(session, agent);
      const subject = subjectOf(session, agent);
      const view = await requiredView(session, agent, fact, subject.id, spec);
      const before = view.attestation;
      const fee = await feeWallet(session);
      const args = { changeAddress: fee.address, attestation: fact.id };
      let reply: { uri: string; sha256: string } | null = null;
      let subjectRef: string | null = null;
      if (spend.kind === 'revoke') {
        if (fact.revokeTx !== null || attestationState(before, session.clock.now()) !== 'active') {
          throw new PreconditionError(`the compliance attestation of ${agent} is not active`);
        }
      } else {
        if (before.status.type !== 'AttRevoked') throw new PreconditionError(`the compliance attestation of ${agent} is not revoked`);
        if (fact.contestTx !== null || fact.replySha256 !== null || fact.replyUri !== null) throw new PreconditionError(`the facts already hold a reply of ${agent}`);
        const onChain = await subjectOnNode(session, agent, subject);
        if (onChain.record.controller !== session.registry.publicKeyOf('controller')) throw new PreconditionError(`the controller key does not control the record of ${agent} on the node`);
        subjectRef = refOf(onChain.utxo);
        const document = replyDocumentOf({ agent, did: subject.did, text: spec.reply.text });
        const digest = await readComplianceDocument(session.fetchImpl, spend.replyUri, document);
        reply = { uri: utf8Hex(spend.replyUri), sha256: digest };
      }
      const { address, hash } = session.chain.deployment.attestation;
      const unit = `${hash}${fact.id}`;
      let effect: { ref: string; timestamp: number } | undefined;
      const landed = await landHosted(session, {
        step: name, tool: kind === 'revoke' ? REVOKE_TOOL : CONTEST_TOOL,
        args: spend.kind === 'revoke' ? { ...args, by: 'issuer', reason: spend.reason } : { ...args, uri: spend.replyUri, sha256: reply!.sha256 },
        expectSigners: [kind === 'revoke' ? spec.issuerKey : 'controller', 'fee'],
        ...(kind === 'revoke' ? { irreversible: 'attestation-revoke' as const } : {}),
        plan: (build, facts) => {
          requireFeeOutputs(name, facts, fee, address);
          if (!facts.inputs.includes(view.ref) || (subjectRef !== null && !facts.referenceInputs.includes(subjectRef))) {
            throw bodyRefusal(name, 'the transaction does not spend the expected attestation and reference the subject where required');
          }
          const at = spend.kind === 'revoke' ? revokeTime(name, build.unsignedCbor, facts, build.validTo) : before.status.type === 'AttRevoked' ? before.status.at : 0;
          const expected: AttestationDatum = spend.kind === 'revoke' ? { ...before, status: { type: 'AttRevoked', at, reason: spend.reason } } : { ...before, contested: reply };
          const output = outputOf(name, facts, address, unit, view.lovelace);
          if (!isDeepStrictEqual(output.datum, expected)) throw bodyRefusal(name, 'the continuing attestation does not match the planned revoke or reply');
          effect = { ref: `${facts.txHash}#${output.index}`, timestamp: at };
          return planOf(session, { destinations: [address], explained: [view.ref], mint: {}, outflow: { fee: session.settings.maxFeeLovelace } });
        },
        refs: () => ({ attestation_id: fact.id, attestation_before: view.ref, attestation_output: effect!.ref }),
        facts: () => ({
          agent, subject: subject.id, issuer_key_hash: keyHashOf(before.issuer), revoked_at: iso(effect!.timestamp),
          ...(spend.kind === 'revoke' ? { reason: spend.reason } : { revoke_reason: String(view.revokeReason), reply_sha256: reply!.sha256, reply_uri: spend.replyUri }),
        }),
      });
      return landed.kind === 'dry' ? { kind: 'dry' } : { kind: 'done', message: `compliance ${kind} of ${agent} is confirmed in ${landed.txHash}` };
    },
    async verify(session, record) {
      requireNetwork(session);
      const fact = heldFact(session, agent);
      const subject = subjectOf(session, agent).id;
      const tx = record.tx_hash;
      const ref = record.refs.attestation_output;
      const reason = record.facts.reason;
      const revokeReason = record.facts.revoke_reason;
      const revokedAt = record.facts.revoked_at;
      const issuerHash = record.facts.issuer_key_hash;
      const replySha256 = record.facts.reply_sha256;
      const replyUri = record.facts.reply_uri;
      if (tx === null || !HEX_32.test(tx) || typeof ref !== 'string' || !ref.startsWith(`${tx}#`) || record.refs.attestation_id !== fact.id
        || record.facts.agent !== agent || record.facts.subject !== subject || typeof issuerHash !== 'string' || !KEY_HASH.test(issuerHash) || typeof revokedAt !== 'string') {
        throw new PreconditionError(`the state does not hold a valid compliance ${kind} of ${agent}`);
      }
      const observed = await eventually(session.clock, VERIFY_WINDOW, async () => {
        const view = await readAttestation(session.chain, fact.id);
        const status = view?.attestation.status;
        const ok = view !== null && view.ref === ref && status?.type === 'AttRevoked' && iso(status.at) === revokedAt && matchesIssue(view, fact, subject, spec, issuerHash)
          && (kind === 'revoke'
            ? issuerHash === session.registry.hashOf(spec.issuerKey) && status.reason === reason
            : String(view.revokeReason) === revokeReason && typeof replyUri === 'string' && validUri(replyUri) && typeof replySha256 === 'string'
              && view.attestation.contested?.sha256 === replySha256 && view.attestation.contested.uri === utf8Hex(replyUri));
        return { done: ok, value: view };
      });
      if (!observed.done) throw new VerificationError(`the node does not show the confirmed compliance ${kind} of ${agent} as built`);
      const common = { agent, attestation_id: fact.id, attestation_output: ref, subject, issuer_key_hash: issuerHash, revoked_at: revokedAt };
      if (kind === 'revoke') {
        session.facts.put('compliance', [agent, 'revokeTx'], tx);
        session.evidence.add({ step: name, status: 'verified', hosted: [], shows: { ...common, reason } });
      } else {
        session.facts.put('compliance', [agent, 'replySha256'], replySha256);
        session.facts.put('compliance', [agent, 'replyUri'], replyUri);
        session.facts.put('compliance', [agent, 'contestTx'], tx);
        session.evidence.add({ step: name, status: 'verified', hosted: [], shows: { ...common, reply_sha256: replySha256, reply_uri: replyUri } });
      }
    },
  };
}

async function cleanup(session: Session): Promise<StepOutcome> {
  if (session.extra.kind !== 'attest' || session.extra.locatorBase !== undefined) throw new FlagError('cleanup takes no compliance flags');
  const spec = session.use.compliance;
  if (spec === null) return { kind: 'finished', message: 'this use case has no compliance attestations' };
  requireNetwork(session);
  let count = 0;
  for (const agent of spec.subjects) {
    if (session.facts.read().compliance[agent] === undefined) continue;
    const fact = heldFact(session, agent);
    const step = `withdraw:${agent}`;
    const view = await readAttestation(session.chain, fact.id);
    if (view === null) {
      const part = session.state.note<StepRecord>(`part.${step}`);
      session.out.out(`${agent}: ${part?.refs.attestation_id === fact.id ? 'the deposit is back already' : 'the attestation is not on the node'}`);
      continue;
    }
    if (!matchesIssue(view, fact, subjectOf(session, agent).id, spec, session.registry.hashOf(spec.issuerKey))) throw new PreconditionError(`the attestation of ${agent} on the node does not match its issue`);
    if (session.state.note(`part.${step}`) !== undefined) throw new PreconditionError(`the state shows a withdrawal of ${agent}, but the node still shows its attestation`);
    const due = view.withdrawableFrom;
    if (due === null) throw new PreconditionError(`the node gives no withdrawal date for ${agent}`);
    const buildFrom = Math.ceil((due + WITHDRAW_LEAD_MS) / 1_000) * 1_000;
    if (session.clock.now() < buildFrom) {
      session.out.out(`${agent}: deposit due on ${iso(due)}; build the withdrawal from ${iso(buildFrom)}`);
      continue;
    }
    const fee = await feeWallet(session);
    const context = await session.chain.context(fee.address);
    const build = await buildWithdrawAttestation(context, { changeAddress: fee.address, id: fact.id, nowMs: session.clock.now(), by: 'issuer' });
    const unit = `${session.chain.deployment.attestation.hash}${fact.id}`;
    const landed = await landBuilt(session, {
      step, built: { unsignedCbor: build.txCbor, txHash: build.txHash, feeLovelace: BigInt(build.fee), validTo: build.validTo }, expectSigners: [spec.issuerKey, 'fee'],
      plan: (facts) => {
        requireFeeOutputs(step, facts, fee);
        if (!facts.inputs.includes(view.ref) || build.validFrom < due) throw bodyRefusal(step, 'the withdrawal must spend the due attestation');
        return planOf(session, { explained: [view.ref], mint: { [unit]: -1n }, outflow: { fee: session.settings.maxFeeLovelace } });
      },
      refs: () => ({ attestation_id: fact.id, attestation_before: view.ref }),
      facts: () => ({ agent, released_lovelace: String(view.lovelace) }),
    });
    if (landed.kind === 'dry') return { kind: 'dry' };
    count += 1;
    session.out.out(`${agent}: the deposit returned to the fee wallet in ${landed.txHash}`);
  }
  return { kind: 'done', message: `compliance deposits withdrawn: ${count}` };
}

async function status(session: Session): Promise<readonly string[]> {
  const spec = session.use.compliance;
  if (spec === null) return ['this use case has no compliance attestations'];
  requireNetwork(session);
  const lines: string[] = [];
  for (const agent of spec.subjects) {
    if (session.facts.read().compliance[agent] === undefined) {
      lines.push(`${agent}: no compliance issue in the facts`);
      continue;
    }
    const fact = heldFact(session, agent);
    const view = await readAttestation(session.chain, fact.id);
    if (view === null) {
      lines.push(`${agent}: the attestation ${fact.id} is not on the node`);
      continue;
    }
    const { attestation: a } = view;
    if (!matchesIssue(view, fact, subjectOf(session, agent).id, spec, session.registry.hashOf(spec.issuerKey))) throw new PreconditionError(`the attestation of ${agent} on the node does not match its issue`);
    lines.push(`${agent}: ${fact.id}, ${attestationState(a, session.clock.now())}, issued ${iso(a.issuedAt)}, valid until ${fact.validUntil}`
      + (a.status.type === 'AttRevoked' ? `, revoked ${iso(a.status.at)} (reason ${view.revokeReason})` : '')
      + (a.contested === null ? '' : `, reply SHA-256 ${a.contested.sha256}`)
      + (view.withdrawableFrom === null ? '' : `, withdrawable from ${iso(view.withdrawableFrom)}`));
  }
  return lines;
}

const compliance: TaskDefinition<Extra> = {
  name: 'compliance', title: 'issue, revoke and reply to compliance attestations',
  flags: ['record', 'revoke', 'contest'], valued: ['agent', 'reason', 'reply-uri', 'locator-base'],
  needs: {
    chain: true, hosted: [READ_TOOL, REVOKE_TOOL, CONTEST_TOOL], approval: 'submit',
    keys: (use, flags) => use.compliance === null || flags.has('record') ? [] : [flags.has('contest') ? 'controller' : use.compliance.issuerKey, 'fee'],
  },
  steps(use, flags) {
    const extra = extraOf(use, flags);
    if (use.compliance === null || extra.kind === 'record') return [];
    return extra.kind === 'attest' ? use.compliance.subjects.map((agent) => `attest:${agent}`) : [`${extra.kind}:${extra.agent}`];
  },
  parse(_env, _settings, use, flags) {
    checkSpec(use);
    return extraOf(use, flags);
  },
  async next(session) {
    const spec = session.use.compliance;
    if (spec === null) return { kind: 'finished', message: 'this use case has no compliance attestations' };
    const { extra } = session;
    if (extra.kind === 'record') return recordDocuments(session, spec);
    return runSteps(session, extra.kind === 'attest' ? spec.subjects.map((agent) => issueStep(spec, agent)) : [spendStep(spec, extra)]);
  },
  cleanup, status,
  result: (session) => ({ compliance: session.facts.read().compliance, documents: session.state.note('documents') ?? [] }),
};

export default compliance;
