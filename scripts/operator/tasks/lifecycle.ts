import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { decodeClaimDatum, paymentKeyHashOf, soleTokenName, utxoOfKoiosRow } from '../../../packages/buyer-core/src/index.ts';
import type { Module1Deployment } from '../../../packages/buyer-core/src/index.ts';
// The package entry does not export the identity build window, guardian rules or datum encoders.
import { windowAt } from '../../../packages/buyer-core/src/vendored/mcp/identity-chain.ts';
import { activeKey, DAYS_7_MS, eligibleGuardian, tombstone } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { WITHDRAW_CLAIM_REDEEMER } from '../../../packages/buyer-core/src/vendored/mcp/jury-codec.ts';
// The package entry does not export the paged out-reference read or the bounded mint/burn history read.
import { koiosCredentialUtxos, koiosPostList } from '../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import { addressDetails } from '../../../packages/vector-read/src/guarded-decode.ts';
import { decodeIdentityAdvertDatum, decodePlutusDataHex } from '../../../packages/vector-read/src/index.ts';
import { encodeIdentityDatum, utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import type { IdentityDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import type { Module1Provider } from '../../../packages/usecase-kit/src/dispute/index.ts';
import { duration, iso } from '../../checks/lib/format.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { StateFile } from '../../checks/lib/state.ts';
import type { StepRecord } from '../../checks/lib/state.ts';
import { VerificationError } from '../../checks/lib/verify.ts';
import { requireGo } from '../lib/approval.ts';
import { proveAdvertRetirement, readConfirmedSpend, valueSeal } from '../lib/confirmed-spend.ts';
import type { RecordSpendDatum } from '../lib/confirmed-spend.ts';
import type { AdvertFact, AgentSpec, ClaimFact, LifecycleSpec, TaskDefinition, TaskSession } from '../lib/contract.ts';
import { readRunning, requireRuntimesFree, runtimesOf } from '../lib/free.ts';
import { blake2b256Hex, createModule1Port, effectiveStatus, formatOutRef, keyHashOf, koiosUtxoInfo, module1FromManifest, PURPOSE, readManifest } from '../lib/platform.ts';
import type { RecordUtxo } from '../lib/platform.ts';
import { readRecord, recordFact, recordSpendStep, resolverReading } from '../lib/record-spend.ts';
import type { RecordSpendSpec } from '../lib/record-spend.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';
import { readLiveClaims } from './claim.ts';

const CHANGE = 'change-controller';
const START = 'recovery-start';
const WAIT = 'recovery-wait';
const COMPLETE = 'recovery-complete';
const RETIRE = 'retire';
const SUCCESSOR = 'set-successor';
const RECLAIM = 'reclaim';
const STEPS = [CHANGE, START, WAIT, COMPLETE, RETIRE, SUCCESSOR, RECLAIM] as const;
type Step = (typeof STEPS)[number];
type Action = Exclude<Step, typeof WAIT>;
const TOOLS = {
  [CHANGE]: 'vector_build_identity_change_controller', [START]: 'vector_build_identity_recovery_start',
  [COMPLETE]: 'vector_build_identity_recovery_complete', [RETIRE]: 'vector_build_identity_retire',
  [SUCCESSOR]: 'vector_build_identity_set_successor', [RECLAIM]: 'vector_build_identity_reclaim',
} as const;
const IRREVERSIBLE = { [CHANGE]: 'controller-change', [COMPLETE]: COMPLETE, [RETIRE]: RETIRE, [SUCCESSOR]: 'successor' } as const;
const PREVIOUS_RECORD = { [CHANGE]: null, [START]: CHANGE, [COMPLETE]: START, [RETIRE]: COMPLETE, [SUCCESSOR]: RETIRE, [RECLAIM]: SUCCESSOR } as const;
const tagOf = (step: Action) => step === START || step === RECLAIM ? undefined : IRREVERSIBLE[step];
const EARLY = 'earlyRecoveryCompletion';
const EARLY_TIMEOUT_MS = 15_000;
const BUILD_LEAD_MS = 60_000;
const MANIFEST_BASE = 'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules';
const HISTORY_BYTES = 512 * 1024;
const ADVERT_CONFIRM_BATCH = 100;
const HASH = /^[0-9a-f]{64}$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,9})$/;

interface Target { readonly lifecycle: LifecycleSpec; readonly agent: AgentSpec }
type Session = TaskSession<Target>;
type Progress = Pick<Session, 'facts'> & { state: Pick<StateFile, 'step'> };
type RecordCheck = Progress & Pick<Session, 'chain' | 'extra'>;
type Closeout = Pick<Session, 'extra' | 'facts' | 'chain' | 'settings' | 'fetchImpl' | 'use'>
  & { clock: Pick<Session['clock'], 'now'>; node: Pick<Session['node'], 'resolveInputs' | 'txStatus'>; registry: Pick<Session['registry'], 'addressOf'> };
const fields = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const digits = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
const refOf = ({ utxo }: RecordUtxo): string => formatOutRef(utxo.txHash, utxo.outputIndex);
const datumHashOf = (record: IdentityDatum): string => blake2b256Hex(Buffer.from(encodeIdentityDatum(record), 'hex'));
const lowerBound = (time: number): number => windowAt(time).lo;

function requireNetwork(session: Pick<Session, 'networkResult'>): void {
  if (session.networkResult()?.ok !== true) throw new PreconditionError('The node did not pass the network guard.');
}

/** Read only the slot clock of the checked node. Do not substitute the operator clock for a missing tip. */
async function nodeTime(session: Session): Promise<number> {
  requireNetwork(session);
  try {
    const start = session.settings.network.systemStartMs ?? (await session.node.networkFacts()).systemStartMs;
    const { slot } = await session.node.networkTip();
    if (start === null || !Number.isSafeInteger(start) || start <= 0 || start % 1_000 !== 0 || !Number.isSafeInteger(slot) || slot < 0) throw new Error();
    const time = start + slot * 1_000;
    if (!Number.isSafeInteger(time) || Number.isNaN(new Date(time).getTime())) throw new Error();
    return time;
  } catch {
    throw new PreconditionError('The node did not give a usable tip time.');
  }
}

function active(record: RecordUtxo, lo: number, hi: number): boolean {
  return record.record.lineage.type === 'Root' && effectiveStatus(record.record, new Map(), lo, hi) === 'Active';
}

function assertController(session: Session, record: IdentityDatum, name: string): void {
  if (record.controller !== session.registry.publicKeyOf(name)) throw new PreconditionError(`The record controller does not match ${name}.`);
}

/** Each verified step has its own fact and follows the exact output of the previous step. */
function lastStep(session: Progress): Step | null {
  const facts = session.facts.read().lifecycle;
  let last: Step | null = null;
  let previous: StepRecord | undefined;
  let gap = false;
  for (const step of STEPS) {
    const saved = session.state.step(step);
    const fact = facts[step];
    if (saved === undefined) {
      if (fact !== undefined) throw new PreconditionError(`The lifecycle fact for ${step} has no matching state.`);
      gap = true;
      continue;
    }
    const named = step === WAIT ? saved.refs.recoveryStart : saved.tx_hash;
    const output = saved.refs.recordAfter;
    if (gap || previous?.verified_at === null || (previous !== undefined && saved.refs.recordBefore !== previous.refs.recordAfter)
      || typeof named !== 'string' || !HASH.test(named) || !REF.test(output)
      || (step === WAIT ? saved.tx_hash !== null || named !== previous?.tx_hash || output !== previous?.refs.recordAfter : !output.startsWith(`${named}#`))
      || (fact !== undefined && (fact.tx !== named || !Number.isFinite(Date.parse(fact.at))
        || (step !== START && step !== WAIT && step !== RETIRE && fact.at !== saved.confirmed_at)
        || (step === WAIT && fact.at !== facts[START]?.at))) || (saved.verified_at !== null && fact === undefined)) {
      throw new PreconditionError(`The lifecycle state does not prove the order and facts for ${step}.`);
    }
    previous = saved;
    last = step;
  }
  return last;
}

function verified(session: Progress, step: Step): StepRecord {
  const part = session.state.step(step);
  if (part === undefined || part.verified_at === null || session.facts.read().lifecycle[step] === undefined) {
    throw new PreconditionError(`Verify ${step} in this lifecycle run first.`);
  }
  return part;
}

function assertOutput(session: RecordCheck, step: Action, current: RecordUtxo): StepRecord {
  const saved = verified(session, step);
  const { address, hash } = session.chain.deployment.identity;
  if (saved.facts.agent !== session.extra.agent.id || saved.facts.did !== `did:vector:${current.id}` || saved.refs.recordAfter !== refOf(current)
    || saved.facts.datumHash !== datumHashOf(current.record) || saved.facts.keptLovelace !== String(current.utxo.assets.lovelace)
    || current.utxo.address !== address || current.utxo.assets[`${hash}${current.id}`] !== 1n || Object.keys(current.utxo.assets).length !== 2
    || current.utxo.scriptRef != null || current.record.lineage.type !== 'Root') {
    throw new PreconditionError(`The node record does not match the verified output of ${step}.`);
  }
  return saved;
}

function pendingOf(session: Session, current: RecordUtxo) {
  const start = assertOutput(session, START, current);
  const { pendingRecovery: pending } = current.record;
  const [first, second] = session.extra.lifecycle.controllers;
  assertController(session, current.record, first);
  if (pending === null || pending.newController !== session.registry.publicKeyOf(second)
    || !Number.isSafeInteger(pending.effectiveAfter) || session.facts.read().lifecycle[START]?.at !== iso(pending.effectiveAfter)) {
    throw new PreconditionError('The node does not show the verified pending recovery for this run.');
  }
  return { pending, start };
}

function guardianIndices(session: Session, record: IdentityDatum, lo: number, hi: number): number[] | null {
  const { lifecycle, agent } = session.extra;
  if (record.guardianThreshold !== agent.guardianThreshold || record.guardianThreshold !== lifecycle.guardians.length) return null;
  const indices: number[] = [];
  for (const name of lifecycle.guardians) {
    const hash = session.registry.hashOf(name);
    const enrolled = agent.parties.find(({ role, signer }) => role === 'Guardian' && signer.kind === 'key' && signer.key === name);
    if (enrolled === undefined) return null;
    const organisation = enrolled.organisation === null ? null : utf8Hex(enrolled.organisation);
    const found = record.parties.flatMap((party, index) => party.role === 'Guardian' && party.signer.type === 'KeyHash' && party.signer.hash === hash && party.organisation === organisation ? [index] : []);
    if (found.length !== 1 || indices.includes(found[0]!) || !eligibleGuardian(record.parties[found[0]!]!, lo, hi)) return null;
    indices.push(found[0]!);
  }
  return indices;
}

/** An absent node output must also have a historical row that proves what was spent. */
async function spentOutputs(session: Closeout, refs: string[]): Promise<Map<string, Awaited<ReturnType<typeof koiosUtxoInfo>>[number]>> {
  if (refs.some((ref) => !REF.test(ref)) || new Set(refs).size !== refs.length) throw new PreconditionError('The closeout facts do not identify distinct outputs.');
  if (refs.length === 0) return new Map();
  let rows: Awaited<ReturnType<typeof koiosUtxoInfo>>;
  try {
    if ((await session.node.resolveInputs(refs)).length !== 0) throw new PreconditionError('A recorded advert or claim output is still live on the node.');
    rows = await koiosUtxoInfo(session.chain.koiosUrl, refs, session.chain.fetchImpl, HISTORY_BYTES);
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    throw new PreconditionError('The historical advert or claim outputs could not be read.');
  }
  const byRef = new Map(rows.map((row) => [`${row?.tx_hash}#${row?.tx_index}`, row]));
  if (rows.length !== refs.length || refs.some((ref) => byRef.get(ref)?.is_spent !== true)) {
    throw new PreconditionError('The ledger does not show every recorded advert and claim output as spent.');
  }
  return byRef;
}

type SpentRows = Awaited<ReturnType<typeof spentOutputs>>;

async function requireRetiredAdverts(session: Closeout, current: RecordUtxo, adverts: Readonly<Record<string, AdvertFact>>, rows: SpentRows): Promise<void> {
  const { agent } = session.extra;
  const { address, hash } = session.chain.deployment.advert;
  try {
    // A Retired update still holds the deposit. Only the confirmed retirement receipt can prove a release.
    const state = StateFile.peek(join(session.settings.stateDir, 'advert.state.json'));
    if (state === null || state.check !== 'advert' || state.network !== session.settings.network.name || state.record !== session.use.name) {
      throw new PreconditionError('Retire the recorded adverts with advert cleanup in the default state stream first.');
    }
    for (const [model, fact] of Object.entries(adverts)) {
      const advert = agent.adverts.find((candidate) => candidate.model === model);
      const row = rows.get(fact.ref);
      const datum = typeof row?.inline_datum?.bytes === 'string' ? decodeIdentityAdvertDatum(row.inline_datum.bytes) : null;
      if (row?.address !== address || !digits(row.value) || advert === undefined || row.value !== String(advert.depositLovelace)
        || !HASH.test(fact.tx) || !fact.ref.startsWith(`${fact.tx}#`) || datum === null
        || datum.agent_id !== current.id || datum.model !== model || datum.capability_id !== agent.capability || datum.detail_uri !== fact.detailUri
        || datum.detail_hash !== fact.detailHash || datum.endpoint_url !== fact.endpoint || datum.status !== 'Active'
        || !activeKey(current.record, datum.supplier_pkh, PURPOSE.transaction)) {
        throw new PreconditionError('A spent advert does not match the recorded advert of the retiring agent.');
      }
      const saved = fields(state.notes[`part.retire:${agent.id}:${model}`]);
      const receipt = fields(saved?.facts);
      const tx = saved?.tx_hash;
      const supplier = receipt?.supplierAddress;
      if (typeof saved?.verified_at !== 'string' || !Number.isFinite(Date.parse(saved.verified_at)) || typeof tx !== 'string' || !HASH.test(tx)
        || fields(saved.refs)?.retiredRef !== fact.ref
        || receipt?.phase !== 'retire' || receipt.agent !== agent.id || receipt.model !== model || receipt.supplierPkh !== datum.supplier_pkh
        || typeof supplier !== 'string' || paymentKeyHashOf(supplier) !== datum.supplier_pkh || receipt.depositLovelace !== row.value
        || !digits(receipt.feeLovelace) || !digits(receipt.creditLovelace) || typeof receipt.valueSeal !== 'string' || !HASH.test(receipt.valueSeal)
        || typeof receipt.approvalSession !== 'string' || receipt.approvalSession === '') {
        throw new PreconditionError('The recorded advert has no matching verified retirement receipt.');
      }
      const flow = await readConfirmedSpend(session, tx, { withDetails: true });
      const credit = proveAdvertRetirement(flow, { advertRef: fact.ref, advertAddress: address, advertScriptHash: hash,
        supplierAddress: supplier, depositLovelace: BigInt(row.value) });
      if (receipt.valueSeal !== valueSeal(flow) || credit !== BigInt(receipt.creditLovelace) || flow.fee !== BigInt(receipt.feeLovelace)) {
        throw new PreconditionError('The confirmed refund does not match the advert retirement receipt.');
      }
    }
    const { provider, koiosUrl, fetchImpl } = session.chain;
    const rejectLive = (output: RecordUtxo['utxo']) => {
      const credential = addressDetails(output.address).paymentCredential;
      if (credential?.type !== 'Script' || credential.hash !== hash) throw new Error();
      if (typeof output.datum !== 'string') return;
      let datum: ReturnType<typeof decodeIdentityAdvertDatum>;
      try { datum = decodeIdentityAdvertDatum(output.datum); } catch { return; }
      if (datum.agent_id === current.id) throw new PreconditionError('The retiring agent still has an unspent advert on the node.');
    };
    // The node lists the deployment address directly. An update can keep the payment script at another address.
    for (const output of await provider.getUtxos(address)) rejectLive(output);
    const candidates = await koiosCredentialUtxos(koiosUrl, hash, fetchImpl, { maxPageBytes: HISTORY_BYTES });
    const refs = candidates.map(({ tx_hash, tx_index }) => formatOutRef(tx_hash, tx_index));
    if (refs.some((ref) => !REF.test(ref))) throw new Error();
    for (let offset = 0; offset < refs.length; offset += ADVERT_CONFIRM_BATCH) {
      const batch = refs.slice(offset, offset + ADVERT_CONFIRM_BATCH);
      const expected = new Set(batch);
      // The indexer locates candidates. Only a matching output still on the node can hold the deposit.
      for (const output of await session.node.resolveInputs(batch)) {
        if (!expected.delete(formatOutRef(output.txHash, output.outputIndex))) throw new Error();
        rejectLive(output);
      }
    }
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    throw new PreconditionError('The confirmed RetireAdvert spend and its supplier credit could not be verified.');
  }
}

const WITHDRAW_CLAIM_HASH = blake2b256Hex(Buffer.from(WITHDRAW_CLAIM_REDEEMER, 'hex'));

/** Module-1 encodes WithdrawClaim as constructor 1 with no fields. */
function isWithdrawClaim({ bytes, value, hash }: RecordSpendDatum): boolean {
  if (bytes == null) {
    if (value == null || (hash != null && hash !== WITHDRAW_CLAIM_HASH)) return false;
  } else {
    try {
      const data = decodePlutusDataHex(bytes);
      if (data.kind !== 'constr' || data.index !== 1n || data.fields.length !== 0) return false;
    } catch { return false; }
  }
  return value == null || ('fields' in value && value.constructor === 1 && value.fields.length === 0);
}

async function requireClaimBurn(session: Closeout, script: Module1Deployment['claim'], claim: ClaimFact, original: ReturnType<typeof decodeClaimDatum>, rows: SpentRows): Promise<void> {
  const { koiosUrl, fetchImpl } = session.chain;
  const history = await koiosPostList(koiosUrl, 'asset_history', { _asset_policy: script.hash, _asset_name: claim.claimToken }, fetchImpl, '', HISTORY_BYTES);
  const row = fields(history[0]);
  const events = row?.minting_txs;
  if (history.length !== 1 || row?.policy_id !== script.hash || row.asset_name !== claim.claimToken || !Array.isArray(events) || events.length !== 2) {
    throw new PreconditionError('The ledger does not prove one mint and one burn of the claim token.');
  }
  const [first, second] = events.map(fields);
  const mint = first?.quantity === '1' || first?.quantity === 1 ? first : second;
  const burn = mint === first ? second : first;
  const tx = burn?.tx_hash;
  if (mint?.tx_hash !== claim.claimTx || (mint.quantity !== '1' && mint.quantity !== 1)
    || (burn?.quantity !== '-1' && burn?.quantity !== -1) || typeof tx !== 'string' || !HASH.test(tx) || tx === claim.claimTx
    || typeof mint.block_time !== 'number' || !Number.isSafeInteger(mint.block_time) || mint.block_time <= 0
    || typeof burn?.block_time !== 'number' || !Number.isSafeInteger(burn.block_time) || burn.block_time < mint.block_time) {
    throw new PreconditionError('The ledger does not prove the recorded claim mint and its terminal burn.');
  }
  if (claim.withdrawTx !== 'not open' && claim.withdrawTx !== tx) {
    throw new PreconditionError('The named claim withdrawal is not its confirmed terminal spend.');
  }
  const flow = await readConfirmedSpend(session, tx, { withDetails: true });
  if (flow.outputs.some((output) => output.asset_list?.some((asset) => asset.policy_id === script.hash && asset.asset_name === claim.claimToken))) {
    throw new PreconditionError('The named terminal spend still creates an output with the claim token.');
  }
  const spends = (flow.spends ?? []).filter((spend) => spend.scriptHash === script.hash);
  const missing = spends.flatMap(({ inputRef }) => rows.has(inputRef) ? [] : [inputRef]);
  const archive = await spentOutputs(session, missing);
  let matched = 0;
  let withdrew = false;
  for (const { inputRef: ref, redeemer } of spends) {
    const held = utxoOfKoiosRow(rows.get(ref) ?? archive.get(ref));
    if (held === null || flow.inputs.find((input) => input.ref === ref)?.address !== held.address) throw new Error();
    const credential = addressDetails(held.address).paymentCredential;
    if (credential?.type !== 'Script' || credential.hash !== script.hash) throw new Error();
    if (soleTokenName(held, held.address, script.hash) !== claim.claimToken || typeof held.datum !== 'string') continue;
    const terminal = decodeClaimDatum(held.datum);
    if (!isDeepStrictEqual({ ...terminal, state: original.state }, original)) continue;
    matched += 1;
    withdrew = claim.withdrawTx !== 'not open' && terminal.state === 'Open' && isWithdrawClaim(redeemer);
  }
  if (matched !== 1) throw new PreconditionError('The terminal spend does not consume the matching claim and token.');
  if (claim.withdrawTx !== 'not open' && !withdrew) throw new PreconditionError('The named claim withdrawal does not show WithdrawClaim on the matching input.');
}

async function requireClosedClaims(session: Closeout, current: RecordUtxo, claims: readonly ClaimFact[], rows: SpentRows): Promise<void> {
  const commit = session.settings.module1Commit;
  if (commit === null) throw new PreconditionError('Set OPERATOR_MODULE1_COMMIT to check the claim deployment before retirement.');
  const source = `${MANIFEST_BASE}/${commit}/${session.use.moduleManifestPath}`;
  const { chain } = session;
  try {
    const module1 = module1FromManifest(await readManifest(source, 'The Module-1 manifest', session.fetchImpl), source);
    if (module1.identityHash !== chain.deployment.identity.hash) throw new PreconditionError('The claim deployment does not use this identity registry.');
    const provider = chain.provider as Partial<Module1Provider>;
    if (typeof provider.getSystemStartMs !== 'function') throw new Error();
    const port = createModule1Port({ provider: provider as Module1Provider, module1, address: session.registry.addressOf('fee'), agent_id: current.id,
      sign: () => { throw new Error('The claim closeout check signs nothing.'); }, clock: () => session.clock.now(),
      sleep: async () => { throw new Error('The claim closeout check does not wait for a transaction.'); },
      koios_url: chain.koiosUrl, fetch: chain.fetchImpl, identity_deployment: null });
    const tokens = new Set(claims.map(({ claimToken }) => claimToken));
    if ((await readLiveClaims(port)).some((claim) => claim.claimer === `did:vector:${current.id}` || tokens.has(claim.token))) {
      throw new PreconditionError('The retiring agent still has a live or moved claim on the node.');
    }
    for (const claim of claims) {
      const original = utxoOfKoiosRow(rows.get(claim.claimRef));
      const datum = typeof original?.datum === 'string' ? decodeClaimDatum(original.datum) : null;
      if (original === null || soleTokenName(original, module1.claim.address, module1.claim.hash) !== claim.claimToken
        || datum === null || datum.state !== 'Open' || datum.claimerDid !== current.id) {
        throw new PreconditionError('A spent claim does not match its recorded agent and claim token.');
      }
      await requireClaimBurn(session, module1.claim, claim, datum, rows);
    }
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    throw new PreconditionError('The confirmed terminal claim spend could not be verified.');
  }
}

async function requireClosed(session: Closeout, current: RecordUtxo): Promise<void> {
  const { agent } = session.extra;
  const facts = session.facts.read();
  const adverts = facts.adverts[agent.id] ?? {};
  if (agent.adverts.some(({ model }) => adverts[model] === undefined)) throw new PreconditionError('The facts do not identify every advert of the retiring agent.');
  const claims = Object.values(facts.claims).flatMap((byAgent) => byAgent[agent.id] === undefined ? [] : [byAgent[agent.id]!]);
  if (claims.some(({ claimRef, claimTx, claimToken, withdrawTx }) => !HASH.test(claimTx) || !claimRef.startsWith(`${claimTx}#`) || !HASH.test(claimToken)
    || (withdrawTx !== 'not open' && (withdrawTx === null || !HASH.test(withdrawTx))))) {
    throw new PreconditionError('A claim of the retiring agent has no valid closeout fact.');
  }
  const rows = await spentOutputs(session, [...Object.values(adverts).map(({ ref }) => ref), ...claims.map(({ claimRef }) => claimRef)]);
  await requireRetiredAdverts(session, current, adverts, rows);
  await requireClosedClaims(session, current, claims, rows);
}

const earlyMessage = (due: number): string => `The build tool refused recovery completion before ${iso(due)}. No transaction was signed.`;

/** Store the attempt before the call. Only the exact, bounded refusal clears the evidence gate. */
async function proveEarlyRefusal(session: Session, start: StepRecord, pending: NonNullable<IdentityDatum['pendingRecovery']>, tip: number): Promise<void> {
  const due = pending.effectiveAfter;
  const checkpoint = { tx: start.tx_hash, effectiveAfter: due };
  const message = earlyMessage(due);
  const note = session.state.note(EARLY);
  const proven = session.evidence.entries().some((entry) => entry.step === WAIT && entry.status === 'tool_refused' && entry.expected === true && entry.tool === TOOLS[COMPLETE] && entry.message === message);
  if (note !== undefined || proven) {
    if (proven && isDeepStrictEqual(note, checkpoint)) return;
    throw new PreconditionError('The early build attempt has no matching refusal evidence. It is not repeated.');
  }
  if (session.mode !== 'submit' || session.clock.now() >= due || tip >= due) {
    throw new PreconditionError('The early recovery check must run with --submit before the recovery opens. No build was requested.');
  }
  session.state.setNote(EARLY, checkpoint);
  const timeout = new AbortController();
  try {
    const answer = await Promise.race([
      session.hosted.call(TOOLS[COMPLETE], { changeAddress: session.registry.addressOf('fee'), did: recordFact(session, session.extra.agent.id).did }),
      delay(EARLY_TIMEOUT_MS, undefined, { signal: timeout.signal, ref: false }).then(() => { throw new Error('The early build timed out.'); }),
    ]);
    const expected = `Failed to build recovery completion: The recovery to the controller key ${keyHashOf(pending.newController)} opens at ${iso(due)}. The validity window must start at or after that time, so build it at or after ${iso(due + BUILD_LEAD_MS)}.`;
    if (!answer.failed || answer.json !== null || answer.text.length > 4_096 || answer.text.includes('```') || answer.text.split('\n', 1)[0] !== expected) {
      throw new VerificationError('The build tool did not give the expected early recovery refusal. Nothing was signed.');
    }
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('The early recovery build call did not return a usable refusal. Nothing was signed.');
  } finally {
    timeout.abort();
  }
  session.evidence.add({ step: WAIT, status: 'tool_refused', expected: true, tool: TOOLS[COMPLETE], message });
}

function waitStep(agent: AgentSpec): StepHandler<Target> {
  return {
    name: WAIT,
    async run(session) {
      const tip = await nodeTime(session);
      const fact = recordFact(session, agent.id);
      const record = await readRecord(session, fact.id);
      const { pending, start } = pendingOf(session, record);
      const due = pending.effectiveAfter;
      if (session.mode === 'submit') await proveEarlyRefusal(session, start, pending, tip);
      const remaining = Math.max(due - tip, due - lowerBound(session.clock.now()));
      if (remaining > 0) return { kind: 'wait', untilMs: due, message: `Recovery opens at ${iso(due)}. At least ${duration(remaining)} remain for the node and build window. Build from ${iso(due + BUILD_LEAD_MS)}.` };
      if (session.mode === 'dry') return { kind: 'dry' };
      const ref = refOf(record);
      session.state.recordStep(WAIT, { confirmed_at: iso(session.clock.now()), tx_hash: null, refs: { recordBefore: ref, recordAfter: ref, recoveryStart: start.tx_hash! },
        facts: { agent: agent.id, effectiveAfter: due } });
      return { kind: 'done', message: `The recovery window that opens at ${iso(due)} has passed.` };
    },
    async verify(session, saved) {
      const tip = await nodeTime(session);
      const { pending, start } = pendingOf(session, await readRecord(session, recordFact(session, agent.id).id));
      const due = pending.effectiveAfter;
      if (saved.tx_hash !== null || saved.refs.recoveryStart !== start.tx_hash || saved.refs.recordBefore !== start.refs.recordAfter || saved.refs.recordAfter !== start.refs.recordAfter
        || saved.facts.agent !== agent.id || saved.facts.effectiveAfter !== due || tip < due || lowerBound(session.clock.now()) < due) {
        throw new VerificationError('The recorded wait does not match the pending recovery and the node time.');
      }
      await proveEarlyRefusal(session, start, pending, tip);
      if (!session.evidence.entries().some((entry) => entry.step === WAIT && entry.status === 'verified')) {
        session.evidence.add({ step: WAIT, status: 'verified', hosted: [], shows: {
          agent: agent.id, recoveryStart: start.tx_hash, record: saved.refs.recordAfter, effectiveAfter: iso(due), nodeAt: iso(tip),
        } });
      }
      session.facts.put('lifecycle', [WAIT], { tx: start.tx_hash, at: iso(due) });
    },
  };
}

function actionStep(target: Target, step: Action): StepHandler<Target> {
  const { agent, lifecycle } = target;
  const [first, second] = lifecycle.controllers;
  const signers = { [CHANGE]: ['controller', first], [START]: [...lifecycle.guardians, second], [COMPLETE]: [], [RETIRE]: [second],
    [SUCCESSOR]: [second, 'controller'], [RECLAIM]: [second] };
  const tag = tagOf(step);
  let successor: RecordUtxo | undefined;
  return recordSpendStep<Target>({
    step, agentId: agent.id, tool: TOOLS[step], expectSigners: [...signers[step], 'fee'], ...(tag === undefined ? {} : { irreversible: tag }),
    args(session) {
      if (step === CHANGE) return { new_controller: session.registry.publicKeyOf(first) };
      if (step === START) return { new_controller: session.registry.publicKeyOf(second), guardians: lifecycle.guardians.map((name) => session.registry.hashOf(name)) };
      if (step === SUCCESSOR) return { successor: recordFact(session, lifecycle.successor).did };
      return {};
    },
    async before(current, session) {
      const previous = PREVIOUS_RECORD[step];
      if (previous !== null) assertOutput(session, previous, current);
      const record = current.record;
      const { lo, hi } = windowAt(session.clock.now());
      assertController(session, record, step === CHANGE ? 'controller' : step === START || step === COMPLETE ? first : second);
      if (step === SUCCESSOR || step === RECLAIM) {
        const next = step === RECLAIM ? recordFact(session, lifecycle.successor).id : null;
        if (record.status.type !== 'Retired' || record.status.successor !== next) throw new PreconditionError('The record is not the required retired tombstone.');
        if (step === SUCCESSOR) {
          successor = await readRecord(session, recordFact(session, lifecycle.successor).id);
          if (!active(successor, lo, hi)) throw new PreconditionError('The successor is not an Active root record for the build window.');
          assertController(session, successor.record, 'controller');
        }
        return;
      }
      if (!active(current, lo, hi)) throw new PreconditionError('The retiring agent record is not Active for the build window.');
      if (step === COMPLETE) {
        const wait = verified(session, WAIT);
        const { pending, start } = pendingOf(session, current);
        if (wait.refs.recoveryStart !== start.tx_hash || wait.facts.effectiveAfter !== pending.effectiveAfter
          || session.facts.read().lifecycle[WAIT]?.at !== iso(pending.effectiveAfter)
          || lo < pending.effectiveAfter || await nodeTime(session) < pending.effectiveAfter) {
          throw new PreconditionError('Recovery completion is not yet allowed by the node and the build window.');
        }
      } else if (record.pendingRecovery !== null) throw new PreconditionError('An unexpected recovery is pending on the record.');
      if (step === START && guardianIndices(session, record, lo, hi) === null) {
        throw new PreconditionError('The enrolled guardians do not meet the record threshold and recover rights for the build window.');
      }
      if (step === RETIRE) await requireClosed(session, current);
    },
    checkBuild(before, after, checked, session) {
      const { action, validFrom: lo, validTo: hi, referenceInputs } = checked;
      const record = before.record;
      let expected: IdentityDatum;
      if (step !== SUCCESSOR && step !== RECLAIM && !active(before, lo, hi)) return 'The agent is not Active for the transaction validity window.';
      switch (step) {
        case CHANGE:
          expected = { ...record, controller: session.registry.publicKeyOf(first), subagentEpoch: record.subagentEpoch + 1 };
          break;
        case START: {
          const guardians = guardianIndices(session, record, lo, hi);
          if (guardians === null || action.type !== 'RecoverInit' || action.guardians.length !== guardians.length
            || new Set(action.guardians).size !== guardians.length || action.guardians.some((index) => !guardians.includes(index))) return 'The recovery does not use exactly the enrolled guardians for the transaction validity window.';
          expected = { ...record, pendingRecovery: { newController: session.registry.publicKeyOf(second), effectiveAfter: hi + DAYS_7_MS } };
          break;
        }
        case COMPLETE:
          if (record.pendingRecovery === null || lo < record.pendingRecovery.effectiveAfter) return 'The signed validity window would start before recovery opens.';
          expected = { ...record, controller: session.registry.publicKeyOf(second), pendingRecovery: null, subagentEpoch: record.subagentEpoch + 1 };
          break;
        case RETIRE:
          expected = tombstone(record, { type: 'Retired', at: lo, successor: null });
          break;
        case SUCCESSOR:
          if (record.status.type !== 'Retired' || successor === undefined || !referenceInputs.includes(refOf(successor))
            || !active(successor, lo, hi) || successor.record.controller !== session.registry.publicKeyOf('controller')) return 'The transaction does not reference the verified Active successor and its controller.';
          expected = { ...record, status: { ...record.status, successor: successor.id } };
          break;
        case RECLAIM:
          return null; // The shared guard checks the unchanged tombstone, exact ledger minimum and positive credit.
      }
      return isDeepStrictEqual(after.record, expected) && after.utxo.assets.lovelace === before.utxo.assets.lovelace ? null : `The unsigned output does not make only the requested ${step} change and preserve the deposit.`;
    },
    after(record, session, before) {
      const { status, controller, pendingRecovery, subagentEpoch } = record.record;
      const expected = step === CHANGE || step === START ? first : second;
      if (controller !== session.registry.publicKeyOf(expected) || subagentEpoch !== before.subagentEpoch + (step === CHANGE || step === COMPLETE ? 1 : 0)) {
        return ['The node does not show the intended controller and subagent epoch.'];
      }
      if (step === START ? pendingRecovery?.newController !== session.registry.publicKeyOf(second) : pendingRecovery !== null) return ['The node does not show the intended recovery state.'];
      if (step === RETIRE || step === SUCCESSOR || step === RECLAIM) {
        const next = step === RETIRE ? null : recordFact(session, lifecycle.successor).id;
        if (status.type !== 'Retired' || status.successor !== next) return ['The node does not show the intended tombstone and successor.'];
      }
      return [];
    },
    facts(session, { txHash, at, record }) {
      const { pendingRecovery, status } = record.record;
      const time = step === START ? iso(pendingRecovery!.effectiveAfter) : step === RETIRE && status.type === 'Retired' ? iso(status.at) : at;
      session.facts.put('lifecycle', [step], { tx: txHash, at: time });
    },
    async evidence(session, _before, record) {
      const { pendingRecovery, status } = record.record;
      const detail = { controller: step === CHANGE || step === START ? first : second, effectiveAfter: pendingRecovery === null ? null : iso(pendingRecovery.effectiveAfter),
        successor: status.type === 'Retired' && status.successor !== null ? `did:vector:${status.successor}` : null };
      return { ...detail, resolver: await resolverReading(session, recordFact(session, agent.id).did),
        ...(step === SUCCESSOR ? { successorResolver: await resolverReading(session, recordFact(session, lifecycle.successor).did) } : {}) };
    },
  } satisfies RecordSpendSpec<Target>);
}

const task: TaskDefinition<Target> = {
  name: 'lifecycle', title: 'Change, recover and close an agent record', flags: [], valued: [],
  needs: { keys: (use) => [...new Set(['controller', 'fee', ...(use.lifecycle?.controllers ?? []), ...(use.lifecycle?.guardians ?? [])])],
    chain: true, hosted: [...Object.values(TOOLS), 'vector_resolve_did'], approval: 'submit' },
  steps: () => STEPS,
  parse(_env, _settings, use, flags) {
    if (flags.value('run') !== 'l1') throw new FlagError('The lifecycle task requires --run l1.');
    const lifecycle = use.lifecycle;
    if (lifecycle === null) throw new PreconditionError('This use case has no lifecycle run.');
    const agent = use.agents.find(({ id }) => id === lifecycle.agent);
    if (agent === undefined || agent.end.record !== 'retired' || agent.end.advert !== 'retired' || agent.end.successor !== lifecycle.successor
      || agent.adverts.length === 0 || use.subagents.some(({ parent }) => parent === agent.id) || !use.records.some(({ id }) => id === lifecycle.successor)
      || agent.id === lifecycle.successor || !use.runs.some(({ id, subject }) => id === 'lifecycle' && subject === agent.id) || lifecycle.waitMs !== DAYS_7_MS) {
      throw new PreconditionError('The lifecycle data does not identify one retirement and its successor.');
    }
    const authorities = [...lifecycle.controllers, ...lifecycle.guardians];
    if (new Set(authorities).size !== 4 || lifecycle.controllers.includes('controller') || !lifecycle.guardians.includes('controller')
      || agent.guardianThreshold !== 2 || authorities.some((name) => ['fee', 'run', 'provider'].includes(name) || !use.keys.some(({ name: key }) => key === name))
      || lifecycle.guardians.some((name) => !agent.parties.some(({ role, signer, rights }) => role === 'Guardian' && signer.kind === 'key' && signer.key === name && (rights === null || rights.includes('recover'))))) {
      throw new PreconditionError('The lifecycle data does not enroll two independent next controllers and two key guardians with the recover right.');
    }
    return { agent, lifecycle };
  },
  async beforeResubmit(session, command, flight) {
    if (command !== 'run') throw new PreconditionError('Only lifecycle run can resend a pending lifecycle transaction.');
    const last = lastStep(session);
    const step = STEPS[last === null ? 0 : STEPS.indexOf(last) + 1];
    const { agent } = session.extra;
    const record = recordFact(session, agent.id);
    if (step === undefined || step === WAIT || step !== flight.step || flight.facts.agent !== agent.id || flight.facts.did !== record.did
      || !HASH.test(flight.txHash) || !REF.test(flight.refs.recordBefore) || !flight.inputRefs.includes(flight.refs.recordBefore)
      || !REF.test(flight.refs.recordAfter) || !flight.refs.recordAfter.startsWith(`${flight.txHash}#`)
      || (last !== null && verified(session, last).refs.recordAfter !== flight.refs.recordBefore)) {
      throw new PreconditionError('The pending transaction is not the next checked spend of this lifecycle run.');
    }
    const tag = tagOf(step);
    const checkApproval = () => requireGo(session.go, { useCase: session.use.name, task: session.task, runWallet: session.registry.addressOf('run'), nowMs: session.clock.now(),
      irreversible: tag === undefined ? [] : [tag] });
    checkApproval();
    requireNetwork(session);
    const current = await readRecord(session, record.id);
    if (refOf(current) !== flight.refs.recordBefore) throw new PreconditionError('The node does not show the original record output of the pending spend.');
    const prior = PREVIOUS_RECORD[step];
    if (prior !== null) assertOutput(session, prior, current);
    if (step === RETIRE) await requireClosed(session, current);
    await requireRuntimesFree({ fetchImpl: session.fetchImpl, runtimes: runtimesOf(agent), out: session.out,
      running: readRunning(join(session.settings.stateDir, 'running-images.json'), session.clock.now()) });
    checkApproval();
  },
  async next(session) {
    const last = lastStep(session);
    const { agent } = session.extra;
    if (last === RECLAIM && session.state.step(RECLAIM)?.verified_at !== null) {
      requireNetwork(session);
      assertOutput(session, RECLAIM, await readRecord(session, recordFact(session, agent.id).id));
    }
    return runSteps(session, STEPS.map((step) => step === WAIT ? waitStep(agent) : actionStep(session.extra, step)));
  },
  async status(session) {
    const last = lastStep(session);
    const facts = session.facts.read().lifecycle;
    const lines = STEPS.map((step) => {
      const fact = facts[step];
      return `${step}: ${fact === undefined || session.state.step(step)?.verified_at == null ? 'no verified fact' : `${fact.tx} at ${fact.at}`}`;
    });
    if (last === null || session.state.snapshot().in_flight !== null || session.state.step(last)?.verified_at === null) return lines;
    requireNetwork(session);
    const current = await readRecord(session, recordFact(session, session.extra.agent.id).id);
    if (last === START || last === WAIT) {
      const pending = pendingOf(session, current).pending;
      const remaining = Math.max(0, pending.effectiveAfter - await nodeTime(session), pending.effectiveAfter - lowerBound(session.clock.now()));
      lines.push(`Recovery opens at ${iso(pending.effectiveAfter)}. ${duration(remaining)} remain for the node and build window.`);
    } else assertOutput(session, last, current);
    return lines;
  },
  async cleanup() { return { kind: 'done', message: 'The steps of a lifecycle are permanent. There is nothing to take back.' }; },
  result: (session) => ({ agent: session.extra.agent.id, lifecycle: session.facts.read().lifecycle }),
};

export default task;
